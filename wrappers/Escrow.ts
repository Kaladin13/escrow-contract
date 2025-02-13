import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core';
import { Maybe } from '@ton/core/dist/utils/maybe';

export type EscrowConfig = {
    ctxId: number;
    sellerAddress: Address;
    guarantorAddress: Address;
    dealAmount: number;
    assetAddress: Maybe<Address>;
    guarantorRoyaltyPercent: number;
    jettonWalletCode: Maybe<Cell>;
};

export const ESCROW_OPCODES = {
    approve: 0xe8c15681,
    cancel: 0xcc0f2526,
    buyerTransfer: 0x9451eca9,
    topUp: 0xae98db22,
    changeWalletCode: 0x9eacde91,
};

export enum ESCROW_STATE {
    INIT = 0,
    FUNDED = 1,
}

export enum ESCROW_EXIT_CODES {
    WRONG_ASSET = 400,
    INCORRECT_FUND_AMOUNT = 401,
    INCORRECT_JETTON = 402,
    INCORRECT_GUARANTOR = 403,
    LOW_FEE_BALANCE = 404,
}

export function escrowConfigToCell(config: EscrowConfig): Cell {
    const initCell = beginCell()
        .storeUint(config.ctxId, 32)
        .storeAddress(config.sellerAddress)
        .storeAddress(config.guarantorAddress)
        .storeUint(config.dealAmount, 64)
        .storeAddress(config.assetAddress);

    const cell2 = beginCell()
        .storeUint(config.guarantorRoyaltyPercent, 32)
        .storeAddress(null)
        .storeUint(0, 2)
        .storeMaybeRef(config.jettonWalletCode)
        .endCell();

    return initCell.storeRef(cell2).endCell();
}

export class Escrow implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Escrow(address);
    }

    static createFromConfig(config: EscrowConfig, code: Cell, workchain = 0) {
        const data = escrowConfigToCell(config);
        const init = { code, data };
        return new Escrow(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendApprove(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(ESCROW_OPCODES.approve, 32).endCell(),
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(ESCROW_OPCODES.cancel, 32).endCell(),
        });
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(ESCROW_OPCODES.topUp, 32).endCell(),
        });
    }

    async sendChangeWalletCode(provider: ContractProvider, via: Sender, value: bigint, newWalletCode: Cell) {
        await provider.internal(via, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(ESCROW_OPCODES.changeWalletCode, 32).storeRef(newWalletCode).endCell(),
        });
    }

    async getState(provider: ContractProvider) {
        const result = await provider.get('get_state', []);
        return result.stack.readNumber() as ESCROW_STATE;
    }

    async getGuaratorRoyalty(provider: ContractProvider) {
        const result = await provider.get('get_guarator_royalty', []);

        return result.stack.readNumber();
    }

    async getEscrowData(provider: ContractProvider) {
        const result = await provider.get('get_escrow_data', []);
        const stack = result.stack;

        return {
            ctxId: stack.readNumber(),
            sellerAddress: stack.readAddress(),
            guarantorAddress: stack.readAddress(),
            dealAmount: stack.readNumber(),
            assetAddress: stack.readAddressOpt(),
            guarantor_royalty_percent: stack.readNumber(),
            buyer_address: stack.readAddressOpt(),
            state: stack.readNumber() as ESCROW_STATE,
            jetton_wallet_code: stack.readCellOpt(),
        };
    }
}
