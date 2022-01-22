import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { mineBlocks } from "./utils/network"
import { parseLogsByName } from "./utils/events"


describe("Bet", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let liquidityProvider: Signer, liquidityProviderAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string

    // Contracts
    let wbnb: Contract, wwbnbLP: Contract, mwbnbLP: Contract
    let woof: Contract, meow: Contract, mwLP: Contract
    let bcnt: Contract, mbcntLP: Contract, wbcntLP: Contract
    let cake: Contract, cbLP: Contract, cwbnbLP: Contract
    let token0: Contract, token1: Contract, lpToken: Contract, isToken01NativeTokenSetting: boolean
    let pancakeRouter: Contract
    let masterChef: Contract
    let poolId: BigNumber, cakerPerBlock: BigNumber
    let converterImpl: Contract
    let converter: Contract
    let betImpl: Contract
    let betCakeFarm: Contract
    let tempStakeManagerImpl: Contract
    let tempStakeManager: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const penaltyPercentage = 50

    const tbnbAddr = "0x509Ba9040dc4091da93f07cdD1e03Dea208e28bf"
    const woofAddr = "0x8dEdf46654B5A8d87a16D92C86ABB769578455B3"
    const meowAddr = "0x505A32c45676777e94689D16F30Df2a0Fa5dBa8e"
    const mwLPAddr = "0x304D9a9969Ea753b1A5d4eB9F3542cb870f4a843"
    const tusdAddr = "0xFD313Bc4bDc701726316DD39E91E7ef45A43F0F7"
    const wuLPAddr = "0x9BC7cb927beeF43E6AcD42275B93CD26854F595f"
    const pancakeRouterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"

    const ownerAddr = "0xb0123A6B61F0b5500EA92F33F24134c814364e3a"

    let numFFBlocks
    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0, minBCNTAmountConverted = 0

    before(async () => {
        [receiver, operator, liquidityProvider] = await ethers.getSigners()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()
        liquidityProviderAddress = await liquidityProvider.getAddress()
        
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddr]
        })

        owner = ethers.provider.getSigner(ownerAddr)
        user = owner
        userAddr = ownerAddr
        
        // Deploy new contracts for testing
        const deciaml = 18
        const initSupply = ethers.utils.parseUnits("10000000")
        wbnb = await (
            await ethers.getContractFactory("WETH9", operator)
        ).deploy()
        const depositValue = ethers.utils.parseEther('9000')
        await wbnb.connect(operator).deposit({ value: depositValue })
        expect(await wbnb.totalSupply()).equal(depositValue)
        cake = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("CAKE", "CAKE", deciaml, initSupply)
        bcnt = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("BCNT", "BCNT", deciaml, initSupply)
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
        mwbnbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, wbnb.address)
        wwbnbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(woof.address, wbnb.address)
        cwbnbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(cake.address, wbnb.address)
        cbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(cake.address, bcnt.address)
        mbcntLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, bcnt.address)
        wbcntLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(woof.address, bcnt.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)
        await pancakeRouter.setLPAddr(meow.address, wbnb.address, mwbnbLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, wbnb.address)).to.equal(mwbnbLP.address)
        await pancakeRouter.setLPAddr(woof.address, wbnb.address, wwbnbLP.address)
        expect(await pancakeRouter.lpAddr(woof.address, wbnb.address)).to.equal(wwbnbLP.address)
        await pancakeRouter.setLPAddr(cake.address, wbnb.address, cwbnbLP.address)
        expect(await pancakeRouter.lpAddr(cake.address, wbnb.address)).to.equal(cwbnbLP.address)
        await pancakeRouter.setLPAddr(cake.address, bcnt.address, cbLP.address)
        expect(await pancakeRouter.lpAddr(cake.address, bcnt.address)).to.equal(cbLP.address)
        await pancakeRouter.setLPAddr(woof.address, bcnt.address, wbcntLP.address)
        expect(await pancakeRouter.lpAddr(woof.address, bcnt.address)).to.equal(wbcntLP.address)
        await pancakeRouter.setLPAddr(meow.address, bcnt.address, mbcntLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, bcnt.address)).to.equal(mbcntLP.address)

        // Add liquidity
        await cake.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await bcnt.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await meow.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await wbnb.connect(operator).approve(pancakeRouter.address, MAX_INT)
        // Add MEOW/WOOF liquidity
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
        // Add MEOW/WBNB liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            wbnb.address,
            ethers.utils.parseUnits("2000"),
            ethers.utils.parseUnits("2000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mwbnbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("4000"))
        // Add WOOF/WBNB liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            woof.address,
            wbnb.address,
            ethers.utils.parseUnits("2000"),
            ethers.utils.parseUnits("2000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await wwbnbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("4000"))
        // Add CAKE/WBNB liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            cake.address,
            wbnb.address,
            ethers.utils.parseUnits("2000"),
            ethers.utils.parseUnits("2000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await cwbnbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("4000"))
        // Add CAKE/BCNT liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            cake.address,
            bcnt.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await cbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
        // Add MEOW/BCNT liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            bcnt.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mbcntLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
        // Add WOOF/BCNT liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            woof.address,
            bcnt.address,
            ethers.utils.parseUnits("1000000"),
            ethers.utils.parseUnits("1000000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await wbcntLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))


        // Two token setting
        isToken01NativeTokenSetting = false
        poolId = BigNumber.from(1)
        token0 = meow
        token1 = woof
        lpToken = mwLP

        // Three token setting
        // isToken01NativeTokenSetting = true
        // poolId = BigNumber.from(2)
        // token0 = meow
        // token1 = wbnb
        // lpToken = mwbnbLP

        // Set up MasterChef pool
        cakerPerBlock = ethers.utils.parseUnits("10")
        masterChef = await (
            await ethers.getContractFactory("MasterChef", operator)
        ).deploy(
            cake.address,
            cakerPerBlock,
            await ethers.provider.getBlockNumber()
        )
        // Set up M/W pool in MasterChef
        const allocPoint = 1000
        const updatePools = true
        await masterChef.connect(operator).add(allocPoint, mwLP.address, updatePools)
        expect(await masterChef.callStatic.poolLength()).to.equal(2)
        // Set up M/WBNB pool in MasterChef
        await masterChef.connect(operator).add(allocPoint, mwbnbLP.address, updatePools)
        expect(await masterChef.callStatic.poolLength()).to.equal(3)
        // Add Cake to MasterChef
        await cake.connect(operator).transfer(masterChef.address, ethers.utils.parseUnits("1000000"))

        const converterName = "Token Converter"
        converterImpl = await (
            await ethers.getContractFactory("Converter", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize", [
            wbnb.address,
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
        expect(await converter.callStatic.NATIVE_TOKEN()).to.equal(wbnb.address)
        expect(await converter.callStatic.name()).to.equal(converterName)
        expect(await converter.callStatic.owner()).to.equal(ownerAddr)
        expect(await converter.callStatic.router()).to.equal(pancakeRouter.address)

        const tempStakeManagerName = "MEOW/WOOF TempStakeManager"
        tempStakeManagerImpl = await (
            await ethers.getContractFactory("TempStakeManagerCakeFarm", operator)
        ).deploy()
        tempStakeManager = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            tempStakeManagerImpl.address,
            "0x"
        )
        tempStakeManager = tempStakeManagerImpl.attach(tempStakeManager.address)

        const betName = "BetCakeFarm"
        betImpl = await (
            await ethers.getContractFactory("BetCakeFarm", operator)
        ).deploy()
        const betInitData = betImpl.interface.encodeFunctionData("initialize", [
            betName,
            ownerAddr,
            bcnt.address,
            cake.address,
            poolId,
            converter.address,
            masterChef.address,
            operatorAddress,
            liquidityProviderAddress,
            tempStakeManager.address,
            penaltyPercentage
        ])
        betCakeFarm = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            betImpl.address,
            betInitData
        )
        // Change Bet instance ABI from UpgradeProxy to Bet implementation
        betCakeFarm = betImpl.attach(betCakeFarm.address)
        expect(await betCakeFarm.callStatic.implementation()).to.equal(betImpl.address)
        expect(await betCakeFarm.callStatic.name()).to.equal(betName)
        expect(await betCakeFarm.callStatic.BCNT()).to.equal(bcnt.address)
        expect(await betCakeFarm.callStatic.cake()).to.equal(cake.address)
        expect(await betCakeFarm.callStatic.converter()).to.equal(converter.address)
        expect(await betCakeFarm.callStatic.masterChef()).to.equal(masterChef.address)
        expect(await betCakeFarm.callStatic.pid()).to.equal(poolId)
        expect(await betCakeFarm.callStatic.token0()).to.equal(token0.address)
        expect(await betCakeFarm.callStatic.token1()).to.equal(token1.address)
        expect(await betCakeFarm.callStatic.operator()).to.equal(operatorAddress)
        expect(await betCakeFarm.callStatic.liquidityProvider()).to.equal(liquidityProviderAddress)
        expect(await betCakeFarm.callStatic.tempStakeManager()).to.equal(tempStakeManager.address)
        expect(await betCakeFarm.callStatic.penaltyPercentage()).to.equal(penaltyPercentage)

        // Initialize TempStakeManager
        await tempStakeManager.initialize(
            tempStakeManagerName,
            operatorAddress,
            bcnt.address,
            cake.address,
            poolId,
            converter.address,
            masterChef.address,
            betCakeFarm.address
        )
        expect(await tempStakeManager.callStatic.implementation()).to.equal(tempStakeManagerImpl.address)
        expect(await tempStakeManager.callStatic.name()).to.equal(tempStakeManagerName)
        expect(await tempStakeManager.callStatic.cake()).to.equal(cake.address)
        expect(await tempStakeManager.callStatic.token0()).to.equal(token0.address)
        expect(await tempStakeManager.callStatic.token1()).to.equal(token1.address)
        expect(await tempStakeManager.callStatic.converter()).to.equal(converter.address)
        expect(await tempStakeManager.callStatic.masterChef()).to.equal(masterChef.address)
        expect(await tempStakeManager.callStatic.pid()).to.equal(poolId)
        expect(await tempStakeManager.callStatic.owner()).to.equal(operatorAddress)
        expect(await tempStakeManager.callStatic.mainContract()).to.equal(betCakeFarm.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('100')})
        // Transfer BCNT to owner
        await bcnt.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await wbnb.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))
        // Transfer LP tokens to owner
        await mwLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        await mwbnbLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))
        await wwbnbLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))
    })

    it("Should not re-initialize", async () => {
        const betName = "BLABLABLA"
        await expect(betCakeFarm.connect(user).initialize(
            betName,
            ownerAddr,
            bcnt.address,
            cake.address,
            poolId,
            converter.address,
            masterChef.address,
            operatorAddress,
            liquidityProviderAddress,
            tempStakeManager.address,
            penaltyPercentage
        )).to.be.revertedWith("Already initialized")

        const tempStakeManagerName = "BLABLABLA"
        await expect(tempStakeManager.connect(user).initialize(
            tempStakeManagerName,
            operatorAddress,
            bcnt.address,
            cake.address,
            poolId,
            converter.address,
            masterChef.address,
            betCakeFarm.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(betCakeFarm.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")

        await expect(tempStakeManager.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with Token0", async () => {
        const userStakeBalanceBefore = await betCakeFarm.callStatic.balanceOf(userAddr)

        const betCakeFarmLPBalanceBefore = await lpToken.callStatic.balanceOf(betCakeFarm.address)
        expect(betCakeFarmLPBalanceBefore).to.equal(0)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        const stakeAmount = ethers.utils.parseUnits('100')
        await token0.connect(user).approve(betCakeFarm.address, stakeAmount)

        const isToken0 = true
        const tx = await betCakeFarm.connect(user).stake(isToken0, stakeAmount, minReceivedToken1Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedBonus = await betCakeFarm.callStatic.earned(userAddr)
        expect(earnedBonus).to.equal(0)
        // Should not accrue any LP tokens in Bet contract
        const betCakeFarmLPBalanceAfter = await lpToken.callStatic.balanceOf(betCakeFarm.address)
        expect(betCakeFarmLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const stakedAmount = betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with Token1", async () => {
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(betCakeFarm.address, stakeAmount)

        const isToken0 = false
        const tx = await betCakeFarm.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const stakedAmount = betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        // LP token amount
        const stakeAmount = ethers.utils.parseUnits('1')
        await lpToken.connect(user).approve(betCakeFarm.address, stakeAmount)

        const tx = await betCakeFarm.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const stakedAmount = betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore)
        expect(stakedAmount).to.equal(stakeAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with native token", async () => {
        if (token0.address == wbnb.address || token1.address == wbnb.address) {
            const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

            const stakeAmount = ethers.utils.parseUnits('1')
            const tx = await betCakeFarm.connect(user).stakeWithNative(minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount,
                {
                    value: stakeAmount
                }
            )
            const receipt = await tx.wait()

            const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
            const stakedAmount = betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore)

            const staked = ethers.utils.formatUnits(
                stakedAmount,
                18
            )
            console.log(`Staked ${staked} LP`)
        } else {
            console.log("Skipped stake with native token test")
        }
    })

    it("Should not earned before reward and profit returned", async () => {
        const earnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)
        expect(earnedBonusBefore).to.equal(0)

        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const earnedBonusAfter = await betCakeFarm.callStatic.earned(userAddr)
        expect(earnedBonusAfter).to.equal(earnedBonusBefore)
    })

    it("Should cook", async () => {
        const operatorRewardAmountBefore = await bcnt.callStatic.balanceOf(operatorAddress)
        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)

        const userRewardShareBefore = await betCakeFarm.callStatic._share(userAddr)

        const totalSupplyBefore = await betCakeFarm.callStatic.totalSupply()
        const bonusBefore = await betCakeFarm.callStatic.bonus()
        const totalRewardShareBefore = await betCakeFarm.callStatic._shareTotal()
        const totalEarnedBonusBefore = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const betCakeFarmEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, betCakeFarm.address)
        // Should have accrued reward
        expect(betCakeFarmEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        // Should not earn any bonus before cook
        expect(totalEarnedBonusBefore).to.equal(0)

        // User's reward locked as MasterChef reward should not be zero
        const userEarnedLockedRewardsBefore = await betCakeFarm.callStatic.earnedLocked(userAddr)
        expect(userEarnedLockedRewardsBefore).to.be.gt(0)

        const tx = await betCakeFarm.connect(operator).cook(minBCNTAmountConverted)

        // Operator should receive rewards
        const operatorRewardAmountAfter = await bcnt.callStatic.balanceOf(operatorAddress)
        expect(operatorRewardAmountAfter).to.be.gt(operatorRewardAmountBefore)
        // expect(tx).to.emit(betCakeFarm, "Cook").withArgs(betCakeFarmEarnedRewardsBefore)
        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        // Should send away all reward
        expect(betCakeFarmRewardBalanceAfter).to.equal(0)

        // Should not change total supply
        const totalSupplyAfter = await betCakeFarm.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should not change bonus amount
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        expect(bonusAfter).to.equal(bonusBefore)
        // Should not change Bet balance 
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        const totalEarnedBonusAfter = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        // Should not earn any bonus after cook
        expect(totalEarnedBonusAfter).to.equal(0)

        // User's reward locked as MasterChef reward should be zero after cook
        const userEarnedLockedRewardsAfter = await betCakeFarm.callStatic.earnedLocked(userAddr)
        expect(userEarnedLockedRewardsAfter).to.equal(0)

        const cookedRewardAmount = betCakeFarmRewardBalanceBefore.sub(betCakeFarmRewardBalanceAfter).add(betCakeFarmEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should transfer stake to TempStakeManager when staking in Lock state", async () => {
        const userTempStkCakeFarmBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkCakeFarmBalanceBefore).to.equal(0)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const tempStkMgrCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(betCakeFarm.address, stakeAmount)

        const isToken0 = false
        const tx = await betCakeFarm.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const userTempStkCakeFarmBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Bet stake balance should remain the same
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        const tempStkMgrCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]
        const stakedAmount = tempStkMgrCakeFarmStakeBalanceAfter.sub(tempStkMgrCakeFarmStakeBalanceBefore)
        expect(tempStkMgrCakeFarmStakeBalanceAfter.sub(tempStkMgrCakeFarmStakeBalanceBefore)).to.equal(stakedAmount)
        expect(userTempStkCakeFarmBalanceAfter.sub(userTempStkCakeFarmBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)
        expect(tx).to.emit(tempStakeManager, "Staked").withArgs(userAddr, stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP into TempStakeManager`)
    })

    it("Should serve", async () => {
        const userEarnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)

        const totalSupplyBefore = await betCakeFarm.callStatic.totalSupply()
        const totalEarnedBonusBefore = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Should not earn any bonus before first serve
        expect(totalEarnedBonusBefore).to.equal(0)
        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        // Should have no reward before serve
        expect(betCakeFarmRewardBalanceBefore).to.equal(0)
        const periodBefore = await betCakeFarm.callStatic.period()
        expect(periodBefore).to.equal(1)

        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const returnedRewardAmount = ethers.utils.parseUnits('1000')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await bcnt.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // operator approve Bet contract
        await bcnt.connect(operator).approve(betCakeFarm.address, returnedRewardAmount)
        const tx = await betCakeFarm.connect(operator).serve(returnedRewardAmount)

        const periodAfter = await betCakeFarm.callStatic.period()
        expect(periodAfter).to.equal(2)

        // User should earn bonus
        const userEarnedBonusAfter = await betCakeFarm.callStatic.earned(userAddr)

        // Should not change total supply
        const totalSupplyAfter = await betCakeFarm.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should update bonus amount 
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        expect(tx).to.emit(betCakeFarm, "Serve").withArgs(returnedRewardAmount)
        // Should not change Bet balance 
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        expect(betCakeFarmRewardBalanceAfter).to.equal(returnedRewardAmount)
        // Should match bonus and reward balance
        expect(betCakeFarmRewardBalanceAfter).to.equal(bonusAfter)
        
        const bonusAmount = bonusAfter
        const bonus = ethers.utils.formatUnits(
            bonusAmount,
            18
        )
        console.log(`Serve ${bonus} bonus`)
        const earnedBonusBefroe = ethers.utils.formatUnits(
            userEarnedBonusBefore,
            18
        )
        const earnedBonusAfter = ethers.utils.formatUnits(
            userEarnedBonusAfter,
            18
        )
        console.log(`User bonus before/after: ${earnedBonusBefroe}/${earnedBonusAfter}`)
    })

    it("Should transfer stake back to Bet after Lock state", async () => {
        const userTempStkCakeFarmBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await betCakeFarm.callStatic.balanceOf(userAddr)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const tempStkMgrCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]

        // Check user is in TempStakeManager staker list
        const numStakers = 1
        const stakerListBefore = await tempStakeManager.callStatic.getAllStakers()
        expect(stakerListBefore.length).to.equal(numStakers)
        expect(stakerListBefore[0]).to.equal(userAddr)

        const stakerIndex = 0
        const tx = await betCakeFarm.connect(operator).transferStake(
            stakerIndex,
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )
        const receipt = await tx.wait()

        const stakerListAfter = await tempStakeManager.callStatic.getAllStakers()
        expect(stakerListAfter.length).to.equal(0)

        const userTempStkCakeFarmBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkCakeFarmBalanceAfter).to.equal(0)
        const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const tempStkMgrCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]
        expect(tempStkMgrCakeFarmStakeBalanceAfter).to.equal(0)
        // Stake should be transferred from TempStakeManager to Bet, along with stake converted from reward
        expect(betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore)).to.be.gte(tempStkMgrCakeFarmStakeBalanceBefore.sub(tempStkMgrCakeFarmStakeBalanceAfter))
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.be.gte(userTempStkCakeFarmBalanceBefore.sub(userTempStkCakeFarmBalanceAfter))
        const transferredStakeAmount = userTempStkCakeFarmBalanceBefore.sub(userTempStkCakeFarmBalanceAfter)
        expect(tx).to.emit(tempStakeManager, "Withdrawn").withArgs(userAddr, transferredStakeAmount)
        const convertedLPAmount = betCakeFarmStakeBalanceAfter.sub(betCakeFarmStakeBalanceBefore).sub(transferredStakeAmount)
        expect(tx).to.emit(tempStakeManager, "ConvertedLP").withArgs(userAddr, convertedLPAmount)


        const transferredStake = ethers.utils.formatUnits(
            transferredStakeAmount,
            18
        )
        const converted = ethers.utils.formatUnits(
            convertedLPAmount,
            18
        )
        console.log(`Transfer ${transferredStake} LP from TempStakeManager to Bet`)
        console.log(`Transfer along with ${converted} LP converted from reward`)
    })

    it("Should withdraw and convert to Token0", async () => {
        const userToken0BalanceBefore = await token0.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await betCakeFarm.callStatic.balanceOf(userAddr)

        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        const withdrawAmount = ethers.utils.parseUnits('5')

        const token0Percentage = 100
        const tx = await betCakeFarm.connect(user).withdraw(minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, withdrawAmount)
        const receipt = await tx.wait()

        const userToken0BalanceAfter = await token0.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userToken0BalanceAfter).to.be.gt(userToken0BalanceBefore)
        const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Should match Bet balance difference and user withdraw amount
        expect(betCakeFarmStakeBalanceBefore.sub(betCakeFarmStakeBalanceAfter)).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
        const receivedToken0 = ethers.utils.formatUnits(
            userToken0BalanceAfter.sub(userToken0BalanceBefore),
            18
        )
        console.log(`Converted to ${receivedToken0} Token0`)
    })

    it("Should withdraw with LP Token", async () => {
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await betCakeFarm.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const withdrawnAmount = betCakeFarmStakeBalanceBefore.sub(betCakeFarmStakeBalanceAfter)
        expect(withdrawnAmount).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
    })

    it("Should withdraw and convert to native token", async () => {
        if (token0.address == wbnb.address || token1.address == wbnb.address) {
            const userNativeTokenBalanceBefore = await user.getBalance()
            const userStakeBalanceBefore = await betCakeFarm.callStatic.balanceOf(userAddr)

            const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

            const withdrawAmount = ethers.utils.parseUnits('1')

            const tx = await betCakeFarm.connect(user).withdrawWithNative(minReceivedToken0Amount, minReceivedToken1Amount, withdrawAmount)
            const receipt = await tx.wait()

            const userNativeTokenBalanceAfter = await user.getBalance()
            // Should receive withdrawal
            expect(userNativeTokenBalanceAfter).to.be.gt(userNativeTokenBalanceBefore)
            const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
            // Should match balance difference and withdraw amount
            expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

            const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
            // Should match Bet balance difference and user withdraw amount
            expect(betCakeFarmStakeBalanceBefore.sub(betCakeFarmStakeBalanceAfter)).to.equal(withdrawAmount)

            const withdrew = ethers.utils.formatUnits(
                withdrawAmount,
                18
            )
            console.log(`Withdrew ${withdrew} LP`)
            const receivedNativeToken = ethers.utils.formatUnits(
                userNativeTokenBalanceAfter.sub(userNativeTokenBalanceBefore),
                18
            )
            console.log(`Converted to ${receivedNativeToken} native token`)
        } else {
            console.log("Skipped withdraw native token test")
        }
    })

    it("Should getReward and user receives all bonus he deserves", async () => {
        // Fast froward some blocks to accrue reward to test `getMasterChefReward`
        numFFBlocks = 10
        await mineBlocks(numFFBlocks)

        const userRewardBalanceBefore = await bcnt.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await betCakeFarm.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await betCakeFarm.callStatic._share(userAddr)
        const userEarnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)

        const totalRewardShareBefore = await betCakeFarm.callStatic._shareTotal()
        const totalEarnedBonusBefore = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        const bonusBefore = await betCakeFarm.callStatic.bonus()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBonusBefore).to.equal(totalEarnedBonusBefore)
        expect(totalEarnedBonusBefore).to.equal(bonusBefore)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const betCakeFarmEarnedRewardsBefore = (await masterChef.callStatic.pendingCake(poolId, betCakeFarm.address)).add(await cake.callStatic.balanceOf(betCakeFarm.address))

        const getMasterChefReward = true
        const tx = await betCakeFarm.connect(user)["getReward(uint256,bool)"](minBCNTAmountConverted, getMasterChefReward)
        const receipt = await tx.wait()

        const userRewardBalanceAfter = await bcnt.callStatic.balanceOf(userAddr)
        // Should receive reward
        expect(userRewardBalanceAfter).to.be.gt(userRewardBalanceBefore)
        const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await betCakeFarm.callStatic._share(userAddr)
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        // Assume no one else staking: should have no rewards left
        expect(bonusAfter).to.equal(0)
        let receivedBonusAmount = bonusBefore.sub(bonusAfter)
        // Should receive bonus
        expect(receivedBonusAmount).to.be.gt(0)
        expect(receivedBonusAmount).to.equal(bonusBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))
        if (getMasterChefReward && betCakeFarmEarnedRewardsBefore.gt(0)) {
            expect(tx).to.emit(betCakeFarm, "MasterChefReward")
            const masterChefRewardEvents = parseLogsByName(betCakeFarm, "MasterChefReward", receipt.logs)
            const actualMasterChefReward = masterChefRewardEvents[0].args.amount
            const expectedMasterChefReward = betCakeFarmEarnedRewardsBefore.mul(userRewardShareBefore).div(totalRewardShareBefore)
            expect(actualMasterChefReward).to.be.gte(expectedMasterChefReward)
            // Diff should be less than 1%
            console.log(`MasterChef reward amount diff: ${actualMasterChefReward.sub(expectedMasterChefReward)}`)
            expect(actualMasterChefReward.sub(expectedMasterChefReward)).to.be.lt(actualMasterChefReward.div(100))
            const rewardPaidEvents = parseLogsByName(betCakeFarm, "RewardPaid", receipt.logs)
            const actualRewardPaid = rewardPaidEvents[0].args.reward
            // Actual received should be less than received Bonus amount plus MasterChef reward amount
            // because it needs to swap MasterChef reward for BCNT
            expect(actualRewardPaid).to.be.lt(receivedBonusAmount.add(actualMasterChefReward))
            receivedBonusAmount = actualRewardPaid
        } else {
            expect(tx).to.emit(betCakeFarm, "RewardPaid").withArgs(userAddr, receivedBonusAmount)
        }

        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Should not change total stake balance
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)

        const receivedBonus = ethers.utils.formatUnits(
            receivedBonusAmount,
            18
        )
        console.log(`Get ${receivedBonus} bonus`)
    })

    it("Should fail to getReward in same period", async () => {
        const getMasterChefReward = true
        await expect(
            betCakeFarm.connect(user)["getReward(uint256,bool)"](
                minBCNTAmountConverted, getMasterChefReward)
        ).to.be.revertedWith("Already getReward in this period")
    })

    it("Should cook", async () => {
        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        const betCakeFarmEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, betCakeFarm.address)
        // Should have accrued reward
        expect(betCakeFarmEarnedRewardsBefore).to.be.gt(0)

        const tx = await betCakeFarm.connect(operator).cook(minBCNTAmountConverted)

        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)

        const cookedRewardAmount = betCakeFarmRewardBalanceBefore.sub(betCakeFarmRewardBalanceAfter).add(betCakeFarmEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should serve", async () => {
        const userEarnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)

        const totalSupplyBefore = await betCakeFarm.callStatic.totalSupply()
        const totalEarnedBonusBefore = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Should not earn any bonus before first serve
        expect(totalEarnedBonusBefore).to.equal(0)
        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        // Should have no reward before serve
        expect(betCakeFarmRewardBalanceBefore).to.equal(0)
        const periodBefore = await betCakeFarm.callStatic.period()
        expect(periodBefore).to.equal(2)

        numFFBlocks = 5000
        await mineBlocks(numFFBlocks)

        const returnedRewardAmount = ethers.utils.parseUnits('1000')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await bcnt.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // operator approve Bet contract
        await bcnt.connect(operator).approve(betCakeFarm.address, returnedRewardAmount)
        const tx = await betCakeFarm.connect(operator).serve(returnedRewardAmount)

        const periodAfter = await betCakeFarm.callStatic.period()
        expect(periodAfter).to.equal(3)

        // User should earn bonus
        const userEarnedBonusAfter = await betCakeFarm.callStatic.earned(userAddr)

        // Should not change total supply
        const totalSupplyAfter = await betCakeFarm.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should update bonus amount 
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        expect(tx).to.emit(betCakeFarm, "Serve").withArgs(returnedRewardAmount)
        // Should not change Bet balance 
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        expect(betCakeFarmRewardBalanceAfter).to.equal(returnedRewardAmount)
        // Should match bonus and reward balance
        expect(betCakeFarmRewardBalanceAfter).to.equal(bonusAfter)
        
        const bonusAmount = bonusAfter
        const bonus = ethers.utils.formatUnits(
            bonusAmount,
            18
        )
        console.log(`Serve ${bonus} bonus`)
        const earnedBonusBefroe = ethers.utils.formatUnits(
            userEarnedBonusBefore,
            18
        )
        const earnedBonusAfter = ethers.utils.formatUnits(
            userEarnedBonusAfter,
            18
        )
        console.log(`User bonus before/after: ${earnedBonusBefroe}/${earnedBonusAfter}`)
        console.log("User bonus before would be zero because he already trigger `getReward`")
    })

    it("Should cook again and enter Lock state", async () => {
        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        const betCakeFarmEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, betCakeFarm.address)
        // Should have accrued reward
        expect(betCakeFarmEarnedRewardsBefore).to.be.gt(0)

        const tx = await betCakeFarm.connect(operator).cook(minBCNTAmountConverted)

        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)

        const cookedRewardAmount = betCakeFarmRewardBalanceBefore.sub(betCakeFarmRewardBalanceAfter).add(betCakeFarmEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should exit and convert to Token1 but user only get part of bonus", async () => {
        const frontRewardsAmount = ethers.utils.parseUnits("10000")
        // Transfer rewards to liquidityProvider because liquidityProvider does not have enough rewards to front the withdraw payment
        await bcnt.connect(owner).transfer(liquidityProviderAddress, frontRewardsAmount)

        const userToken1BalanceBefore = await token1.callStatic.balanceOf(userAddr)
        const userStakeBefore = await betCakeFarm.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await betCakeFarm.callStatic._share(userAddr)
        const userEarnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)

        const totalRewardShareBefore = await betCakeFarm.callStatic._shareTotal()
        const totalEarnedBonusBefore = await betCakeFarm.callStatic.earned(betCakeFarm.address)
        const bonusBefore = await betCakeFarm.callStatic.bonus()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBonusBefore).to.equal(totalEarnedBonusBefore)
        expect(totalEarnedBonusBefore).to.equal(bonusBefore)

        // Liquidity provider approve Bet contract to transfer rewards from him to front the withdraw payment
        await bcnt.connect(liquidityProvider).approve(betCakeFarm.address, MAX_INT)
        const token0Percentage = 0
        const tx = await betCakeFarm.connect(user).exit(minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage)
        const receipt = await tx.wait()
        // Liquidity provider clear allowance
        await bcnt.connect(liquidityProvider).approve(betCakeFarm.address, 0)

        const userToken1alanceAfter = await token1.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userToken1alanceAfter).to.be.gt(userToken1BalanceBefore)
        const userStakeBalanceAfter = await betCakeFarm.callStatic.balanceOf(userAddr)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await betCakeFarm.callStatic._share(userAddr)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await betCakeFarm.callStatic._shareTotal()
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        // Should be rewards left since part of bonus are given to operator
        expect(totalRewardShareAfter).to.be.gt(0)
        expect(bonusAfter).to.be.gt(0)
        const receivedBonusAmount = bonusBefore.sub(bonusAfter)
        // Should receive bonus tokens
        expect(receivedBonusAmount).to.be.gt(0)
        expect(tx).to.emit(betCakeFarm, "RewardPaid").withArgs(userAddr, receivedBonusAmount)
        const expectedEarnedWithdrawn = userRewardShareBefore
        // User should only receive part of bonus since he withdraw in Lock state
        const expectedBonusAmountReceived = bonusBefore.mul(expectedEarnedWithdrawn).mul(100 - penaltyPercentage).div(100).div(totalRewardShareBefore)
        // Should match actual received bonus amount and expected received bonus Amount
        // It can not be exact match because rewards are accrueing every seconds and time is different
        // the moment you query it and the moment transaction executes 
        const bonusAmountDiff = (
            receivedBonusAmount.gt(expectedBonusAmountReceived) ?
            receivedBonusAmount.sub(expectedBonusAmountReceived) : expectedBonusAmountReceived.sub(receivedBonusAmount)
        )
        console.log(`Bonus amount diff: ${bonusAmountDiff}`)
        expect(bonusAmountDiff).to.be.lt(10**6)
        // Operator should receive the other part of bonus
        const liquidityProviderRewardShareAfter = await betCakeFarm.callStatic._share(liquidityProviderAddress)
        expect(liquidityProviderRewardShareAfter).to.equal(totalRewardShareAfter)
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Assume no one else staking: should be no Bet balance left
        expect(betCakeFarmStakeBalanceAfter).to.equal(0)

        const stakeAmount = ethers.utils.formatUnits(
            userStakeBefore,
            18
        )
        const receivedBonus = ethers.utils.formatUnits(
            receivedBonusAmount,
            18
        )
        console.log(`Exit with ${stakeAmount} LP and get ${receivedBonus} reward`)
        const receivedToken1 = ethers.utils.formatUnits(
            userToken1alanceAfter.sub(userToken1BalanceBefore),
            18
        )
        console.log(`Converted them to ${receivedToken1} Token1`)
    })

    it("Should transfer stake to TempStakeManager when staking in Lock state", async () => {
        const userTempStkCakeFarmBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkCakeFarmBalanceBefore).to.equal(0)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        const tempStkMgrCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(betCakeFarm.address, stakeAmount)

        const isToken0 = false
        const tx = await betCakeFarm.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const userTempStkCakeFarmBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Bet stake balance should remain the same
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        const tempStkMgrCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, tempStakeManager.address))[0]
        const stakedAmount = tempStkMgrCakeFarmStakeBalanceAfter.sub(tempStkMgrCakeFarmStakeBalanceBefore)
        expect(tempStkMgrCakeFarmStakeBalanceAfter.sub(tempStkMgrCakeFarmStakeBalanceBefore)).to.equal(stakedAmount)
        expect(userTempStkCakeFarmBalanceAfter.sub(userTempStkCakeFarmBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)
        expect(tx).to.emit(tempStakeManager, "Staked").withArgs(userAddr, stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP into TempStakeManager`)
    })

    it("Should abort user from TempStakeManager", async () => {
        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const userRewardBalanceBefore = await bcnt.callStatic.balanceOf(userAddr)
        const userMWLPBalanceBefore = await lpToken.callStatic.balanceOf(userAddr)
        const userTempStkEarnedBefore = await tempStakeManager.callStatic.earned(userAddr)
        const userTempStkCakeFarmBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkCakeFarmBalanceBefore).to.be.gt(0)
        const betCakeFarmStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]

        const tx = await betCakeFarm.connect(operator).abortFromTempStakeManager([userAddr], [minBCNTAmountConverted])
        const receipt = await tx.wait()

        const userRewardBalanceAfter = await bcnt.callStatic.balanceOf(userAddr)
        const userMWLPBalanceAfter = await lpToken.callStatic.balanceOf(userAddr)
        const userTempStkCakeFarmBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkCakeFarmBalanceAfter).to.equal(0)
        const returnedLPAmount = userMWLPBalanceAfter.sub(userMWLPBalanceBefore)
        expect(returnedLPAmount).to.equal(userTempStkCakeFarmBalanceBefore.sub(userTempStkCakeFarmBalanceAfter))
        const betCakeFarmStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, betCakeFarm.address))[0]
        // Bet stake balance should remain the same
        expect(betCakeFarmStakeBalanceAfter).to.equal(betCakeFarmStakeBalanceBefore)
        expect(userTempStkCakeFarmBalanceAfter).to.equal(0)
        const userEarnedRewardAmount = userRewardBalanceAfter.sub(userRewardBalanceBefore)
        expect(userEarnedRewardAmount).to.be.gte(userTempStkEarnedBefore)
        expect(tx).to.emit(tempStakeManager, "Abort").withArgs(userAddr, userTempStkCakeFarmBalanceBefore)
        // expect(tx).to.emit(tempStakeManager, "RewardPaid").withArgs(userAddr, userEarnedRewardAmount)

        const returnedLP = ethers.utils.formatUnits(
            returnedLPAmount,
            18
        )
        console.log(`Returned ${returnedLP} LP`)
        const earned = ethers.utils.formatUnits(
            userEarnedRewardAmount,
            18
        )
        console.log(`Earned ${earned} Rewards during staking in TempStakeManager`)
    })

    it("Should serve", async () => {
        const userEarnedBonusBefore = await betCakeFarm.callStatic.earned(userAddr)

        const totalSupplyBefore = await betCakeFarm.callStatic.totalSupply()
        const betCakeFarmRewardBalanceBefore = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        // Should have no reward before serve
        expect(betCakeFarmRewardBalanceBefore).to.equal(0)

        const returnedRewardAmount = ethers.utils.parseUnits('10')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await bcnt.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // operator approve Bet contract
        await bcnt.connect(operator).approve(betCakeFarm.address, returnedRewardAmount)
        const tx = await betCakeFarm.connect(operator).serve(returnedRewardAmount)

        const periodAfter = await betCakeFarm.callStatic.period()
        expect(periodAfter).to.equal(4)

        // User should earn bonus
        const userEarnedBonusAfter = await betCakeFarm.callStatic.earned(userAddr)

        // Should not change total supply
        const totalSupplyAfter = await betCakeFarm.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should update bonus amount 
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        // Should match bonus and reward balance
        const betCakeFarmRewardBalanceAfter = await bcnt.callStatic.balanceOf(betCakeFarm.address)
        expect(betCakeFarmRewardBalanceAfter).to.equal(returnedRewardAmount)
        expect(betCakeFarmRewardBalanceAfter).to.equal(bonusAfter)
        expect(tx).to.emit(betCakeFarm, "Serve").withArgs(returnedRewardAmount)
        
        const bonusAmount = bonusAfter
        const bonus = ethers.utils.formatUnits(
            bonusAmount,
            18
        )
        console.log(`Serve ${bonus} bonus`)
        const earnedBonusBefroe = ethers.utils.formatUnits(
            userEarnedBonusBefore,
            18
        )
        const earnedBonusAfter = ethers.utils.formatUnits(
            userEarnedBonusAfter,
            18
        )
        console.log(`User bonus before/after: ${earnedBonusBefroe}/${earnedBonusAfter}`)
        console.log("User bonus would be zero because he already trigger `exit`")
    })

    it("Should get bonus for liquidity provider", async () => {
        const lpRewardBalanceBefore = await bcnt.callStatic.balanceOf(liquidityProviderAddress)
        const earnedBonusBefore = await betCakeFarm.callStatic.earned(liquidityProviderAddress)
        expect(earnedBonusBefore).to.be.gt(0)
        const bonusBefore = await betCakeFarm.callStatic.bonus()
        expect(bonusBefore).to.be.gt(0)

        await betCakeFarm.connect(liquidityProvider).liquidityProviderGetBonus()

        const earnedBonusAfter = await betCakeFarm.callStatic.earned(liquidityProviderAddress)
        expect(earnedBonusAfter).to.equal(0)
        const bonusAfter = await betCakeFarm.callStatic.bonus()
        expect(bonusAfter).to.equal(0)
        const lpRewardBalanceAfter = await bcnt.callStatic.balanceOf(liquidityProviderAddress)
        expect(lpRewardBalanceAfter.sub(lpRewardBalanceBefore)).to.equal(bonusBefore.sub(bonusAfter))

        const receivedBonusAmount = earnedBonusBefore.sub(earnedBonusAfter)
        const receivedBonus = ethers.utils.formatUnits(
            receivedBonusAmount,
            18
        )
        console.log(`Liquidity provider get ${receivedBonus} Reward`)
    })
})