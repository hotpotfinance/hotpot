import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { setERC20Balance } from "./utils/balance"
import * as addr from "./utils/address"
import { encodePath, FeeAmount } from "./utils/uniV3"
import { parseLogsByName } from "./utils/events"

describe("Converter", function () {
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20"

    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let user: Signer, userAddress: string

    // Contracts
    let weth: Contract, bcnt: Contract, usdc: Contract
    let uniV3Router: Contract
    let converterImpl: Contract
    let converter: Contract

    const uniV2RouterAddr = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    const uniV3RouterAddr = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    // const uniV3ConverterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"

    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0

    before(async () => {
        [user, receiver, operator] = await ethers.getSigners()
        userAddress = await user.getAddress()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()

        // Use fork mainnet state
        weth = await ethers.getContractAt(IERC20, addr.WETH_ADDR)
        expect(await weth.totalSupply()).gt(0)
        bcnt = await ethers.getContractAt(IERC20, addr.BCNT_ADDR)
        expect(await bcnt.totalSupply()).gt(0)
        usdc = await ethers.getContractAt(IERC20, addr.USDC_ADDR)
        expect(await usdc.totalSupply()).gt(0)
        uniV3Router = await ethers.getContractAt("IPancakeRouter", uniV3RouterAddr)

        // Deploy Converter
        const converterName = "Token Converter with UniV3"
        converterImpl = await (
            await ethers.getContractFactory("ConverterUniV3", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize(address,string,address,address,address)", [
            addr.WETH_ADDR,  // Route the swap path through native token
            converterName,
            operatorAddress,
            uniV2RouterAddr,
            uniV3Router.address
        ])
        converter = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            converterImpl.address,
            converterInitData
        )
        // Change instance ABI from UpgradeProxy to implementation
        converter = converterImpl.attach(converter.address)
        expect(await converter.callStatic.name()).to.equal(converterName)
        expect(await converter.callStatic.owner()).to.equal(operatorAddress)
        expect(await converter.callStatic.router()).to.equal(uniV2RouterAddr)
        expect(await converter.callStatic.routerUniV3()).to.equal(uniV3Router.address)

        // Set token balance
        await setERC20Balance(bcnt.address, userAddress, ethers.utils.parseEther("10000000"))
        await setERC20Balance(usdc.address, userAddress, ethers.utils.parseUnits("10000000", "mwei"))
    })

    it("Should not re-initialize", async () => {
        const converterName = "BLABLABLA"
        await expect(converter.connect(receiver).functions["initialize(address,string,address,address,address)"](
            usdc.address,
            converterName,
            receiverAddress,
            uniV2RouterAddr,
            uniV3Router.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(converter.connect(receiver).upgradeTo(
            uniV3Router.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should convert USDC to BCNT", async () => {
        const userUSDCBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        expect(userUSDCBalanceBefore).to.be.gt(0)
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        expect(userBCNTBalanceBefore).to.be.gt(0)

        const converterUSDCBalanceBefore = await usdc.callStatic.balanceOf(converter.address)
        expect(converterUSDCBalanceBefore).to.equal(0)
        const converterBCNTBalanceBefore = await bcnt.callStatic.balanceOf(converter.address)
        expect(converterBCNTBalanceBefore).to.equal(0)

        const amountToConvert = ethers.utils.parseUnits("100", "mwei")
        await usdc.connect(user).approve(converter.address, amountToConvert)

        const convertPercentage = 50
        const minAmount = 0
        const path = encodePath(
            [usdc.address, weth.address, bcnt.address],
            [FeeAmount.MEDIUM, FeeAmount.HIGH]
        )
        const tx = await converter.connect(user).convertUniV3(usdc.address, amountToConvert, convertPercentage, bcnt.address, minAmount, userAddress, path)
        const receipt = await tx.wait()
        const events = parseLogsByName(converter, "ConvertedUniV3", receipt.logs)
        for (const event of events) {
            console.log(event.args.initAmount.toString())
            console.log(event.args.amountIn.toString())
            console.log(event.args.amountOut.toString())
        }

        const userUSDCalanceAfter = await usdc.callStatic.balanceOf(userAddress)
        expect(userUSDCBalanceBefore.sub(userUSDCalanceAfter)).to.equal(amountToConvert.div(2))
        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        const receivedAmount = userBCNTBalanceAfter.sub(userBCNTBalanceBefore)
        expect(receivedAmount).to.be.gt(0)

        const converterUSDCBalanceAfter = await usdc.callStatic.balanceOf(converter.address)
        expect(converterUSDCBalanceAfter).to.equal(0)
        const converterBCNTBalanceAfter = await bcnt.callStatic.balanceOf(converter.address)
        expect(converterBCNTBalanceAfter).to.equal(0)


        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} BCNT`)
    })

    it("Should convert BCNT to WETH and send to someone else", async () => {
        const receiverWETHBalanceBefore = await weth.callStatic.balanceOf(receiverAddress)

        const userWETHBalanceBefore = await weth.callStatic.balanceOf(userAddress)
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        expect(userBCNTBalanceBefore).to.be.gt(0)

        const converterWETHBalanceBefore = await weth.callStatic.balanceOf(converter.address)
        expect(converterWETHBalanceBefore).to.equal(0)
        const converterBCNTBalanceBefore = await bcnt.callStatic.balanceOf(converter.address)
        expect(converterBCNTBalanceBefore).to.equal(0)

        const amountToConvert = ethers.utils.parseUnits("100") // 100
        await bcnt.connect(user).approve(converter.address, amountToConvert)

        const convertPercentage = 80
        const minAmount = 0
        const path = encodePath(
            [bcnt.address, weth.address],
            [FeeAmount.HIGH]
        )
        const tx = await converter.connect(user).convertUniV3(bcnt.address, amountToConvert, convertPercentage, weth.address, minAmount, receiverAddress, path)
        const receipt = await tx.wait()
        const events = parseLogsByName(converter, "ConvertedUniV3", receipt.logs)
        for (const event of events) {
            console.log(event.args.initAmount.toString())
            console.log(event.args.amountIn.toString())
            console.log(event.args.amountOut.toString())
        }

        const userWETHBalanceAfter = await weth.callStatic.balanceOf(userAddress)
        expect(userWETHBalanceAfter).to.equal(userWETHBalanceBefore)
        const userBCNTalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        expect(userBCNTBalanceBefore.sub(userBCNTalanceAfter)).to.equal(amountToConvert)

        const receiverWETHBalanceAfter = await weth.callStatic.balanceOf(receiverAddress)
        const receivedAmount = receiverWETHBalanceAfter.sub(receiverWETHBalanceBefore)
        expect(receivedAmount).to.be.gt(0)

        const converterWETHBalanceAfter = await weth.callStatic.balanceOf(converter.address)
        expect(converterWETHBalanceAfter).to.equal(0)
        const converterBCNTBalanceAfter = await bcnt.callStatic.balanceOf(converter.address)
        expect(converterBCNTBalanceAfter).to.equal(0)


        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} WETH`)
    })
})