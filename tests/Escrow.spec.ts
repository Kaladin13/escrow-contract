import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow, ESCROW_OPCODES, ESCROW_STATE, EscrowConfig } from '../wrappers/Escrow';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Maybe } from '@ton/core/dist/utils/maybe';

describe('Escrow', () => {
    let escrowCode: Cell;
    let minterJettonCode: Cell;
    let jwalletCode: Cell;

    beforeAll(async () => {
        escrowCode = await compile('Escrow');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let escrow: SandboxContract<Escrow>;
    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let guarantor: SandboxContract<TreasuryContract>;
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
            jettonWalletCode: jwalletCode,
        };
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        // escrow = blockchain.openContract(Escrow.createFromConfig({}, code));

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        guarantor = await blockchain.treasury('guarantor');

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
        const escrowConfig = generateEscrowConfig(beginCell().storeAddress(guarantor.address).endCell(), 100, 1000);

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
        expect(escrowData.assetAddress).toEqualCell(beginCell().storeAddress(guarantor.address).endCell());
        expect(escrowData.jetton_wallet_code).toEqual(null);
        expect(escrowData.buyer_address).toEqual(null);
        expect(escrowData.guarantor_royalty_percent).toEqual(1000);
    });

    it('should accept correct ton funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowConfig = generateEscrowConfig(null, dealAmount, 1000);

        const escrowContract = blockchain.openContract(Escrow.createFromConfig(escrowConfig, escrowCode));

        const deployResult = await escrowContract.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

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

        const escrowData = await escrowContract.getEscrowData();
        expect(escrowData.buyer_address).toEqualAddress(buyer.address);
    });
});
