import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow, ESCROW_OPCODES, EscrowConfig } from '../wrappers/Escrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Maybe } from '@ton/core/dist/utils/maybe';
import { jettonContentToCell, JettonMinter } from '../wrappers/ft/JettonMinter';
import { JettonWallet } from '../wrappers/ft/JettonWallet';
import { Op } from '../wrappers/ft/JettonConstants';

const SECONDS = 1000;
jest.setTimeout(70 * SECONDS);

function getUsedGas(sendEnough: SendMessageResult) {
    return sendEnough.transactions
        .slice(1)
        .map((t) =>
            t.description.type === 'generic' && t.description.computePhase.type === 'vm'
                ? t.description.computePhase.gasUsed
                : 0n,
        )
        .reduceRight((prev, cur) => prev + cur);
}

describe('Escrow FunC Gas benchmarks', () => {
    let escrowCode: Cell;
    let minterJettonCode: Cell;
    let jwalletCode: Cell;
    let defaultContent: Cell;
    let userWallet: (a: Address) => Promise<SandboxContract<JettonWallet>>;

    beforeAll(async () => {
        escrowCode = await compile('Escrow');
        jwalletCode = await compile('ft/JettonWallet');
        minterJettonCode = await compile('ft/JettonMinter');

        defaultContent = jettonContentToCell({ type: 1, uri: 'https://testjetton.org/content.json' });
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let guarantor: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;
    let lastCtxId = 1;

    const generateEscrowConfig = (
        assetAddress: Maybe<Address>,
        dealAmount: number | bigint,
        royalty: number,
    ): EscrowConfig => {
        if (typeof dealAmount == 'bigint') {
            dealAmount = parseInt(dealAmount.toString());
        }

        return {
            assetAddress,
            ctxId: lastCtxId++,
            dealAmount,
            guarantorAddress: guarantor.address,
            sellerAddress: seller.address,
            guarantorRoyaltyPercent: royalty,
            jettonWalletCode: assetAddress === null ? null : jwalletCode,
        };
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        guarantor = await blockchain.treasury('guarantor');

        // jettons setup
        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployer.address,
                    content: defaultContent,
                    wallet_code: jwalletCode,
                },
                minterJettonCode,
            ),
        );
        userWallet = async (address: Address) =>
            blockchain.openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(address)));

        await jettonMinter.sendDeploy(deployer.getSender(), toNano('100'));
        await jettonMinter.sendMint(deployer.getSender(), buyer.address, toNano(100), toNano('0.05'), toNano('1'));
    });

    it('send funding ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const tonFundingResult = await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        expect(tonFundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.buyerTransfer,
            success: true,
            exitCode: 0,
        });

        const gasUsed = getUsedGas(tonFundingResult);
        console.log(`Gas used ton funding`, gasUsed);
    });

    it('send funding jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowConfig = generateEscrowConfig(jettonMinter.address, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const buyerJettonWallet = await userWallet(buyer.address);

        const jettonFundingResult = await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        expect(jettonFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: Op.transfer_notification,
            success: true,
        });

        expect(jettonFundingResult.transactions).not.toHaveTransaction({
            success: false,
        });

        const gasUsed = getUsedGas(jettonFundingResult);
        console.log(`Gas used jetton funding`, gasUsed);
    });

    it('change wallet code', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(jettonMinter.address, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const escrowDataBefore = await escrowContract.getEscrowData();
        expect(escrowDataBefore.jetton_wallet_code).toEqualCell(jwalletCode);

        const newJwalletCode = beginCell().endCell();

        const res = await escrowContract.sendChangeWalletCode(seller.getSender(), toNano('0.05'), newJwalletCode);

        expect(res.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.changeWalletCode,
            success: true,
        });

        const gasUsed = getUsedGas(res);
        console.log(`Gas used change wallet code`, gasUsed);
    });

    // check ton happy path
    it('guarantor approve ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        const guaratorAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.05'));

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: true,
        });

        expect(guaratorAllowResult.transactions).not.toHaveTransaction({
            success: false,
        });

        const gasUsed = getUsedGas(guaratorAllowResult);
        console.log(`Gas used guarantor approve ton`, gasUsed);
    });

    // jetton happy path
    it('guarantor approve jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(jettonMinter.address, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));
        const buyerJettonWallet = await userWallet(buyer.address);

        await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        const guaratorAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.05'));

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: true,
        });

        const gasUsed = getUsedGas(guaratorAllowResult);
        console.log(`Gas used guarantor approve jetton`, gasUsed);
    });

    // check ton guarator cancel path
    it('guarator cancel deal ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        const guaratorCancelResult = await escrowContract.sendCancel(guarantor.getSender(), toNano('0.05'));

        expect(guaratorCancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.cancel,
            success: true,
        });

        const gasUsed = getUsedGas(guaratorCancelResult);
        console.log(`Gas used guarantor cancel ton`, gasUsed);
    });

    // jetton cancel path
    it('guarator cancel deal jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(jettonMinter.address, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));
        const buyerJettonWallet = await userWallet(buyer.address);

        await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount,
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        const guaratorcancelResult = await escrowContract.sendCancel(guarantor.getSender(), toNano('0.05'));

        expect(guaratorcancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.cancel,
            success: true,
        });

        const gasUsed = getUsedGas(guaratorcancelResult);
        console.log(`Gas used guarantor cancel jetton`, gasUsed);
    });
});
