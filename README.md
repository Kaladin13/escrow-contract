# TON Escrow Smart Contract

Escrow contract that can accept payments in TON/Jettons, allow trusted party (Guarantor) to approve/cancel the deal and handles Guarantor royalties. Also includes CLI application to create, deploy and operate the escrow contract. Based on `Escrow Wrapper`, it should be easy to create any sdk/ui application

## Implementation details

While the general flow is simple to understand, there are a few subtleties

- This implementation allows `Buyer`, `Guarantor` and `Seller` all to be the same accounts, logic still would hold
- Asset type is set on deployment and cannot be changed on already created escrow contract (except *jetton_wallet_code*, see `change_wallet_code#9eacde91` for this)
- After `Guarantor` successfully approves/cancels the deal, escrow contract destroys itself
- Royalties percent floating point uses decimal constant as hack for precise calculations (see `calculate_gauarantor_royalty`)
- Deal amount and other escrow parameters cannot be changed after deployment by anyone including `Seller` (if you want to change any deal inputs except *jetton_wallet_code*, create&deploy new escrow instance)

## Layout

-   `contracts` - contains the source code of all the smart contracts of the project and their dependencies
-   `contracts/ft` and `wrappers/ft` - contains TEP jetton contracts and wrappers
-   `wrappers` - contains the wrapper
-   `tests` - tests for the escrow contract
-   `scripts` - contains CLI application as blueprint script

## How to use

### Using the CLI application

CLI application is implemented as blueprint script, use `npx blueprint run` to launch it and then follow terminal instructions

### Testing

This implemetation includes comprehensive testing of both TON and Jetton type of deals and payments, check `tests/Escrow.spec.ts` to see them

Run `npx blueprint test`

### TLB

TLB schemes for storage and instructions can be found in contract source code


# License

MIT
