import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow, ESCROW_OPCODES, ESCROW_STATE, EscrowConfig } from '../wrappers/Escrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Maybe } from '@ton/core/dist/utils/maybe';
import { jettonContentToCell, JettonMinter } from '../wrappers/ft/JettonMinter';
import { JettonWallet } from '../wrappers/ft/JettonWallet';
import { Op } from '../wrappers/ft/JettonConstants';

const SECONDS = 1000;
jest.setTimeout(70 * SECONDS);

describe('Escrow', () => {
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
    let escrow: SandboxContract<Escrow>;
    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let guarantor: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;
    let lastCtxId = 1;

    const generateEscrowConfig = (
        assetAddress: Maybe<Cell>,
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

        // escrow = blockchain.openContract(Escrow.createFromConfig({}, code));

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

        // const deployResult = await escrow.sendDeploy(deployer.getSender(), toNano('0.05'));

        // expect(deployResult.transactions).toHaveTransaction({
        //     from: deployer.address,
        //     to: escrow.address,
        //     deploy: true,
        //     success: true,
        // });
    });

    it('should deploy with correct initial state ton', async () => {
        const escrowConfig = generateEscrowConfig(null, 100, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        const deployResult = await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        const state = await escrowContract.getState();

        expect(state).toBe(ESCROW_STATE.INIT);

        const escrowData = await escrowContract.getEscrowData();

        expect(escrowData.ctxId).toBe(1);
        expect(escrowData.sellerAddress).toEqualAddress(seller.address);
        expect(escrowData.guarantorAddress).toEqualAddress(guarantor.address);
        expect(escrowData.dealAmount).toEqual(100);
        expect(escrowData.assetAddress).toEqualCell(beginCell().endCell());
        expect(escrowData.jetton_wallet_code).toEqual(null);
        expect(escrowData.buyer_address).toEqual(null);
        expect(escrowData.guarantor_royalty_percent).toEqual(1000);
    });

    it('should deploy with correct initial state jetton', async () => {
        const escrowConfig = generateEscrowConfig(beginCell().storeAddress(jettonMinter.address).endCell(), 100, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        const deployResult = await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        const state = await escrowContract.getState();

        expect(state).toBe(ESCROW_STATE.INIT);

        const escrowData = await escrowContract.getEscrowData();

        expect(escrowData.ctxId).toBe(2);
        expect(escrowData.sellerAddress).toEqualAddress(seller.address);
        expect(escrowData.guarantorAddress).toEqualAddress(guarantor.address);
        expect(escrowData.dealAmount).toEqual(100);
        expect(escrowData.assetAddress).toEqualCell(beginCell().storeAddress(jettonMinter.address).endCell());
        expect(escrowData.jetton_wallet_code).toEqualCell(jwalletCode);
        expect(escrowData.buyer_address).toEqual(null);
        expect(escrowData.guarantor_royalty_percent).toEqual(1000);
    });

    it('should accept correct ton funding', async () => {
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
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.FUNDED);

        // should set buyer address after funding
        const escrowData = await escrowContract.getEscrowData();
        expect(escrowData.buyer_address).toEqualAddress(buyer.address);
    });

    it('should accept correct jetton funding', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

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

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.FUNDED);

        const escrowData = await escrowContract.getEscrowData();
        // notice, we set buyer_address as w4/w5 wallet address, not buyers' jetton wallet
        expect(escrowData.buyer_address).toEqualAddress(buyer.address);
    });

    it('should reject incorrect amount', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const buyerJettonWallet = await userWallet(buyer.address);

        const jettonFundingResult = await buyerJettonWallet.sendTransfer(
            buyer.getSender(),
            toNano('0.1'),
            dealAmount - 1n, // send less jettons than offered
            escrowContract.address,
            buyer.address,
            null as unknown as Cell,
            toNano('0.05'),
            null as unknown as Cell,
        );

        expect(jettonFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: Op.transfer_notification,
            success: false,
            exitCode: 401,
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.INIT);
    });

    it('should reject jetton funding from wrong contract', async () => {
        const dealAmount = toNano(5); // 5 jetton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        // malicious jetton buy attempt
        const maliciousFundingResult = await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell()
                .storeUint(Op.transfer_notification, 32)
                .storeUint(0, 32)
                .storeCoins(dealAmount)
                .storeAddress(buyer.address)
                .endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        expect(maliciousFundingResult.transactions).toHaveTransaction({
            to: escrowContract.address,
            aborted: true,
            exitCode: 402,
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.INIT);
    });

    it('should correctly calcuate guarator royalty', async () => {
        const dealAmount = toNano(1); // 1 ton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const guaratorRoyalty = await escrowContract.getGuaratorRoyalty();

        // 1 percent
        expect(BigInt(guaratorRoyalty)).toEqual(dealAmount / 100n);
    });

    // check ton happy path
    it('should allow guarator to approve deal after ton funding', async () => {
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

        const guaratorRoyalty = BigInt(await escrowContract.getGuaratorRoyalty());

        const guaratorAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.05'));

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: true,
        });

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: seller.address,
            value: dealAmount - guaratorRoyalty,
            success: true,
        });

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: guarantor.address,
            value: (v) => v! >= guaratorRoyalty && v! <= guaratorRoyalty + toNano(1), // in-between check cause 128+32 send mode
            success: true,
        });
    });
});
