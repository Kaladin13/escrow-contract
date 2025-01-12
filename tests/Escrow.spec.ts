import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow, ESCROW_EXIT_CODES, ESCROW_OPCODES, ESCROW_STATE, EscrowConfig } from '../wrappers/Escrow';
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
            exitCode: ESCROW_EXIT_CODES.INCORRECT_FUND_AMOUNT,
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.INIT);
    });

    it('should reject double funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.FUNDED);

        const res = await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        expect(res.transactions).toHaveTransaction({
            to: escrowContract.address,
            success: false,
            exitCode: ESCROW_EXIT_CODES.WRONG_ASSET,
        });
    });

    it('should change wallet code', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

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

        const escrowDataAfter = await escrowContract.getEscrowData();
        expect(escrowDataAfter.jetton_wallet_code).toEqualCell(newJwalletCode);
    });

    it('should reject wallet code change from not seller', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const newJwalletCode = beginCell().endCell();

        // buyer not sender
        const res = await escrowContract.sendChangeWalletCode(buyer.getSender(), toNano('0.05'), newJwalletCode);

        expect(res.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: ESCROW_OPCODES.changeWalletCode,
            success: false,
            exitCode: ESCROW_EXIT_CODES.INCORRECT_GUARANTOR,
        });
    });

    it('should reject wallet code change after funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        // funding
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

        const newJwalletCode = beginCell().endCell();

        const res = await escrowContract.sendChangeWalletCode(seller.getSender(), toNano('0.05'), newJwalletCode);

        expect(res.transactions).toHaveTransaction({
            to: escrowContract.address,
            op: ESCROW_OPCODES.changeWalletCode,
            success: false,
            exitCode: ESCROW_EXIT_CODES.WRONG_ASSET,
        });
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
            exitCode: ESCROW_EXIT_CODES.INCORRECT_JETTON,
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

    it('should cap max royalty at threshold', async () => {
        const dealAmount = toNano(1); // 1 ton

        // 101 percent guarator royalty
        const escrowConfig = generateEscrowConfig(null, dealAmount, 101000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        const guaratorRoyalty = await escrowContract.getGuaratorRoyalty();

        // 90 percent max threshold
        expect(BigInt(guaratorRoyalty)).toEqual((dealAmount / 100n) * 90n);
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

    // jetton happy path
    it('should allow guarator to approve deal after jetton funding', async () => {
        const dealAmount = toNano(5); // 5 jetton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

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

        const guaratorRoyalty = BigInt(await escrowContract.getGuaratorRoyalty());

        const sellerJettonWallet = await userWallet(seller.address);
        const guarantorJettonWallet = await userWallet(guarantor.address);

        const sellerJettonBalanceBefore = await sellerJettonWallet.getJettonBalance();
        const guarantorJettonBalanceBefore = await guarantorJettonWallet.getJettonBalance();

        const guaratorAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.05'));

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: true,
        });

        const sellerJettonBalanceAfter = await sellerJettonWallet.getJettonBalance();
        const guarantorJettonBalanceAfter = await guarantorJettonWallet.getJettonBalance();

        expect(guaratorAllowResult.transactions).toHaveTransaction({
            to: sellerJettonWallet.address,
            success: true,
        });

        expect(sellerJettonBalanceBefore).toEqual(sellerJettonBalanceAfter - (dealAmount - guaratorRoyalty));
        expect(guarantorJettonBalanceBefore).toEqual(guarantorJettonBalanceAfter - guaratorRoyalty);
    });

    it('should reject wrong guarator', async () => {
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

        // buyer trying to act as guarator
        const maliciousGuaratorAllowResult = await escrowContract.sendApprove(buyer.getSender(), toNano('0.05'));

        expect(maliciousGuaratorAllowResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            success: false,
            exitCode: ESCROW_EXIT_CODES.INCORRECT_GUARANTOR,
        });
    });

    it('should reject guarator approve before funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        // without funding
        const maliciousGuaratorAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.05'));

        expect(maliciousGuaratorAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: ESCROW_EXIT_CODES.INCORRECT_GUARANTOR,
        });
    });

    // check ton guarator cancel path
    it('should allow guarator to cancel deal', async () => {
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

        expect(guaratorCancelResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: buyer.address,
            value: (v) => v! >= dealAmount && v! <= dealAmount + toNano(1), // in-between check cause 128+32 send mode
            success: true,
        });
    });

    // jetton cancel path
    it('should allow guarator to cancel deal jetton', async () => {
        const dealAmount = toNano(5); // 5 jetton

        // 1 percent guarator royalty
        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

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

        const buyerJettonBalanceBefore = await buyerJettonWallet.getJettonBalance();

        const guaratorcancelResult = await escrowContract.sendCancel(guarantor.getSender(), toNano('0.05'));

        expect(guaratorcancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.cancel,
            success: true,
        });

        const buyerJettonBalanceAfter = await buyerJettonWallet.getJettonBalance();

        expect(guaratorcancelResult.transactions).toHaveTransaction({
            to: buyerJettonWallet.address,
            success: true,
        });

        expect(buyerJettonBalanceBefore).toEqual(buyerJettonBalanceAfter - dealAmount);
    });

    it('should reject wrong asset funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        // set asset to jetton on deploy
        const escrowConfig = generateEscrowConfig(
            beginCell().storeAddress(jettonMinter.address).endCell(),
            dealAmount,
            1000,
        );

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        // try to fund with ton
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
            success: false,
            exitCode: ESCROW_EXIT_CODES.WRONG_ASSET,
        });

        const stateAfterFunding = await escrowContract.getState();
        expect(stateAfterFunding).toBe(ESCROW_STATE.INIT);
    });

    it('should reject low fee approve and accept top up', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        // deploy with low initial amount
        await escrowContract.sendDeploy(deployer.getSender(), toNano('0.01'));

        await buyer.send({
            to: escrowContract.address,
            value: dealAmount,
            body: beginCell().storeUint(ESCROW_OPCODES.buyerTransfer, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });

        // approve with low value
        const guaratorLowFeeAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.01'));

        expect(guaratorLowFeeAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: false,
            exitCode: ESCROW_EXIT_CODES.LOW_FEE_BALANCE, // low fee
        });

        // top up with enouth ton for execution
        const topUpResult = await escrowContract.sendTopUp(seller.getSender(), toNano('0.1'));

        // approve after topped up
        const guaratorToppedAllowResult = await escrowContract.sendApprove(guarantor.getSender(), toNano('0.01'));

        expect(guaratorToppedAllowResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            op: ESCROW_OPCODES.approve,
            success: true,
        });
    });
});
