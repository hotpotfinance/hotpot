import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"

describe("Converter", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string

    // Contracts
    let woof: Contract, meow: Contract, mwLP: Contract
    let pancakeRouter: Contract
    let converterImpl: Contract
    let converter: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const tbnbAddr = "0x509Ba9040dc4091da93f07cdD1e03Dea208e28bf"
    const woofAddr = "0x8dEdf46654B5A8d87a16D92C86ABB769578455B3"
    const meowAddr = "0x505A32c45676777e94689D16F30Df2a0Fa5dBa8e"
    const mwLPAddr = "0x304D9a9969Ea753b1A5d4eB9F3542cb870f4a843"
    const pancakeRouterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"

    const ownerAddr = "0xb0123A6B61F0b5500EA92F33F24134c814364e3a"

    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0

    before(async () => {
        [receiver, operator] = await ethers.getSigners()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()

        // Use fork mainnet state
        // woof = await ethers.getContractAt("mintersBEP2EToken", woofAddr)
        // expect(await woof.totalSupply()).gt(0)
        // meow = await ethers.getContractAt("mintersBEP2EToken", meowAddr)
        // expect(await meow.totalSupply()).gt(0)
        // mwLP = await ethers.getContractAt("mintersBEP2EToken", mwLPAddr)
        // expect(await mwLP.totalSupply()).gt(0)
        // pancakeRouter = await ethers.getContractAt("IPancakeRouter", pancakeRouterAddr)

        // Deploy new contracts for testing
        const deciaml = 18
        const initSupply = ethers.utils.parseUnits("10000000")
        meow = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("MEOW", "MEOW", deciaml, initSupply)
        expect(await meow.totalSupply()).equal(initSupply)
        woof = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("WOOF", "WOOF", deciaml, initSupply)
        expect(await woof.totalSupply()).equal(initSupply)
        mwLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, woof.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)

        // Add liquidity
        await meow.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            woof.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mwLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))

        const converterName = "Token Converter"
        converterImpl = await (
            await ethers.getContractFactory("Converter", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize", [
            tbnbAddr,  // Route the swap path through native token
            converterName,
            ownerAddr,
            pancakeRouter.address
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
        expect(await converter.callStatic.owner()).to.equal(ownerAddr)
        expect(await converter.callStatic.router()).to.equal(pancakeRouter.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))

        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddr]
        })

        user = ethers.provider.getSigner(ownerAddr)
        userAddr = ownerAddr

        // User add liquidity
        await meow.connect(user).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(user).approve(pancakeRouter.address, MAX_INT)
        await pancakeRouter.connect(user).addLiquidity(
            meow.address,
            woof.address,
            ethers.utils.parseUnits("10000"),
            ethers.utils.parseUnits("10000"),
            0,
            0,
            userAddr,
            0
        )
        expect(await mwLP.callStatic.balanceOf(userAddr)).to.equal(ethers.utils.parseUnits("20000"))
    })

    it("Should not re-initialize", async () => {
        const converterName = "BLABLABLA"
        await expect(converter.connect(receiver).initialize(
            meow.address,
            converterName,
            operatorAddress,
            pancakeRouter.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(converter.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should convert MEOW to WOOF", async () => {
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore).to.be.gt(0)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        await meow.connect(user).approve(converter.address, amountToConvert)

        const convertPercentage = 50
        const minAmount = 0
        const tx = await converter.connect(user).convert(meow.address, amountToConvert, convertPercentage, woof.address, minAmount, userAddr)
        const receipt = await tx.wait()

        const userMEOWalanceAfter = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore.sub(userMEOWalanceAfter)).to.equal(amountToConvert.div(2))
        const userWOOFBalanceAfter = await woof.callStatic.balanceOf(userAddr)
        const receivedAmount = userWOOFBalanceAfter.sub(userWOOFBalanceBefore)
        expect(receivedAmount).to.be.gt(0)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)


        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} WOOF`)
    })

    it("Should convert WOOF to MEOW and send to someone else", async () => {
        const receiverMEOWBalanceBefore = await meow.callStatic.balanceOf(receiverAddress)

        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        await woof.connect(user).approve(converter.address, amountToConvert)

        const convertPercentage = 80
        const minAmount = 0
        const tx = await converter.connect(user).convert(woof.address, amountToConvert, convertPercentage, meow.address, minAmount, receiverAddress)
        const receipt = await tx.wait()

        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceAfter).to.equal(userMEOWBalanceBefore)
        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore.sub(userWOOFalanceAfter)).to.equal(amountToConvert)

        const receiverMEOWBalanceAfter = await meow.callStatic.balanceOf(receiverAddress)
        const receivedAmount = receiverMEOWBalanceAfter.sub(receiverMEOWBalanceBefore)
        expect(receivedAmount).to.be.gt(0)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)


        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} MEOW`)
    })

    it("Should convert MEOW to WOOF and add liquidity and send to someone else", async () => {
        const receiverLPBalanceBefore = await mwLP.callStatic.balanceOf(receiverAddress)

        const userLPBalanceBefore = await mwLP.callStatic.balanceOf(userAddr)
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore).to.be.gt(0)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        await meow.connect(user).approve(converter.address, amountToConvert)

        const tx = await converter.connect(user).convertAndAddLiquidity(
            meow.address,
            amountToConvert,
            woof.address,
            minReceivedToken0Amount,
            minReceivedToken0Amount,
            minReceivedToken1Amount,
            receiverAddress
        )
        const receipt = await tx.wait()

        const receiverLPBalanceAfter = await mwLP.callStatic.balanceOf(receiverAddress)
        const userLPBalanceAfter = await mwLP.callStatic.balanceOf(userAddr)
        expect(userLPBalanceAfter).to.equal(userLPBalanceBefore)
        const userMEOWalanceAfter = await meow.callStatic.balanceOf(userAddr)
        const usedMEOWAmount = userMEOWBalanceBefore.sub(userMEOWalanceAfter)
        expect(usedMEOWAmount).to.be.lte(amountToConvert)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)

        const receivedAmount = receiverLPBalanceAfter.sub(receiverLPBalanceBefore)
        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} LP`)
    })

    it("Should convert WOOF to MEOW and add liquidity", async () => {
        const userLPBalanceBefore = await mwLP.callStatic.balanceOf(userAddr)
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore).to.be.gt(0)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        await woof.connect(user).approve(converter.address, amountToConvert)

        const tx = await converter.connect(user).convertAndAddLiquidity(
            woof.address,
            amountToConvert,
            meow.address,
            minReceivedToken1Amount,
            minReceivedToken1Amount,
            minReceivedToken0Amount,
            userAddr
        )
        const receipt = await tx.wait()

        const userLPBalanceAfter = await mwLP.callStatic.balanceOf(userAddr)
        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        const usedWOOFAmount = userWOOFBalanceBefore.sub(userWOOFalanceAfter)
        expect(usedWOOFAmount).to.be.lte(amountToConvert)
        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)

        const receivedAmount = userLPBalanceAfter.sub(userLPBalanceBefore)
        const received = ethers.utils.formatUnits(
            receivedAmount,
            18
        )
        console.log(`Received ${received} LP`)
    })

    it("Should remove liquidity and convert to 50/50 MEOW and WOOF", async () => {
        const userLPBalanceBefore = await mwLP.callStatic.balanceOf(userAddr)
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        expect(userMEOWBalanceBefore).to.be.gt(0)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        expect(userWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        expect(userLPBalanceBefore).to.be.gte(amountToConvert)
        await mwLP.connect(user).approve(converter.address, amountToConvert)

        const convertPercentage = 50
        const tx = await converter.connect(user).removeLiquidityAndConvert(mwLP.address, amountToConvert, minReceivedToken0Amount, minReceivedToken1Amount, convertPercentage, userAddr)
        const receipt = await tx.wait()

        const userLPBalanceAfter = await mwLP.callStatic.balanceOf(userAddr)
        expect(userLPBalanceBefore.sub(userLPBalanceAfter)).to.equal(amountToConvert)
        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        const receivedWOOFAmount = userWOOFalanceAfter.sub(userWOOFBalanceBefore)
        expect(receivedWOOFAmount).to.be.gt(0)
        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        const receivedMEOWAmount = userMEOWBalanceAfter.sub(userMEOWBalanceBefore)
        expect(receivedMEOWAmount).to.be.gt(0)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)

        const receivedWOOF = ethers.utils.formatUnits(
            receivedWOOFAmount,
            18
        )
        const receivedMEOW = ethers.utils.formatUnits(
            receivedMEOWAmount,
            18
        )
        console.log(`Received ${receivedWOOF} WOOF and ${receivedMEOW} MEOW`)
    })

    it("Should remove liquidity and convert to 10/90 MEWO and WOOF and send to someone else", async () => {
        const userLPBalanceBefore = await mwLP.callStatic.balanceOf(userAddr)
        const receiverMEOWBalanceBefore = await meow.callStatic.balanceOf(receiverAddress)
        expect(receiverMEOWBalanceBefore).to.be.gt(0)
        const receiverWOOFBalanceBefore = await woof.callStatic.balanceOf(receiverAddress)
        expect(receiverWOOFBalanceBefore).to.be.gt(0)

        const converterMEOWBalanceBefore = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceBefore).to.equal(0)
        const converterWOOFBalanceBefore = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceBefore).to.equal(0)

        const amountToConvert = BigNumber.from("100000000000000000000") // 100
        expect(userLPBalanceBefore).to.be.gte(amountToConvert)
        await mwLP.connect(user).approve(converter.address, amountToConvert)

        const token0Percentage = 10 // Convert to 10% MEOW and 90% WOOF
        const tx = await converter.connect(user).removeLiquidityAndConvert(mwLP.address, amountToConvert, minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, receiverAddress)
        const receipt = await tx.wait()

        const userLPBalanceAfter = await mwLP.callStatic.balanceOf(userAddr)
        expect(userLPBalanceBefore.sub(userLPBalanceAfter)).to.equal(amountToConvert)
        const receiverWOOFalanceAfter = await woof.callStatic.balanceOf(receiverAddress)
        const receivedWOOFAmount = receiverWOOFalanceAfter.sub(receiverWOOFBalanceBefore)
        expect(receivedWOOFAmount).to.be.gt(0)
        const receiverMEOWBalanceAfter = await meow.callStatic.balanceOf(receiverAddress)
        const receivedMEOWAmount = receiverMEOWBalanceAfter.sub(receiverMEOWBalanceBefore)
        expect(receivedMEOWAmount).to.be.gt(0)

        const converterMEOWBalanceAfter = await meow.callStatic.balanceOf(converter.address)
        expect(converterMEOWBalanceAfter).to.equal(0)
        const converterWOOFBalanceAfter = await woof.callStatic.balanceOf(converter.address)
        expect(converterWOOFBalanceAfter).to.equal(0)

        const receivedWOOF = ethers.utils.formatUnits(
            receivedWOOFAmount,
            18
        )
        const receivedMEOW = ethers.utils.formatUnits(
            receivedMEOWAmount,
            18
        )
        console.log(`Received ${receivedWOOF} WOOF and ${receivedMEOW} MEOW`)
    })
})