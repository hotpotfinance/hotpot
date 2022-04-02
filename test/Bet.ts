import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./utils/network"
import { parseLogsByName } from "./utils/events"


describe("Bet", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let liquidityProvider: Signer, liquidityProviderAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string

    // Contracts
    let wbnb: Contract, wbLP: Contract, mbLP: Contract
    // let tusd: Contract, wuLP: Contract, muLP: Contract
    let woof: Contract, meow: Contract, mwLP: Contract
    let token0: Contract, token1: Contract, lpToken: Contract, rewardToken: Contract, isThreeTokenSetting: boolean
    let pancakeRouter: Contract
    let stakingRewards: Contract
    let converterImpl: Contract
    let converter: Contract
    let betImpl: Contract
    let bet: Contract
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

    let ffSeconds
    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0

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
        meow = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("MEOW", "MEOW", deciaml, initSupply)
        expect(await meow.totalSupply()).equal(initSupply)
        woof = await (
            await ethers.getContractFactory("mintersBEP2EToken", operator)
        ).deploy("WOOF", "WOOF", deciaml, initSupply)
        // tusd = await (
        //     await ethers.getContractFactory("mintersBEP2EToken", operator)
        // ).deploy("TUSD", "TUSD", deciaml, initSupply)
        expect(await woof.totalSupply()).equal(initSupply)
        mwLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, woof.address)
        // muLP = await (
        //     await ethers.getContractFactory("StubPancakePair", operator)
        // ).deploy(meow.address, tusd.address)
        // wuLP = await (
        //     await ethers.getContractFactory("StubPancakePair", operator)
        // ).deploy(woof.address, tusd.address)
        mbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, wbnb.address)
        wbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(woof.address, wbnb.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)
        // await pancakeRouter.setLPAddr(meow.address, tusd.address, muLP.address)
        // expect(await pancakeRouter.lpAddr(meow.address, tusd.address)).to.equal(muLP.address)
        // await pancakeRouter.setLPAddr(woof.address, tusd.address, wuLP.address)
        // expect(await pancakeRouter.lpAddr(woof.address, tusd.address)).to.equal(wuLP.address)
        await pancakeRouter.setLPAddr(meow.address, wbnb.address, mbLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, wbnb.address)).to.equal(mbLP.address)
        await pancakeRouter.setLPAddr(woof.address, wbnb.address, wbLP.address)
        expect(await pancakeRouter.lpAddr(woof.address, wbnb.address)).to.equal(wbLP.address)

        // Add MEOW/WOOF liquidity
        await meow.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await woof.connect(operator).approve(pancakeRouter.address, MAX_INT)
        // await tusd.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await wbnb.connect(operator).approve(pancakeRouter.address, MAX_INT)
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
        // // Add MEOW/TUSD liquidity
        // await pancakeRouter.connect(operator).addLiquidity(
        //     meow.address,
        //     tusd.address,
        //     ethers.utils.parseUnits("1000000"),
        //     ethers.utils.parseUnits("1000000"),
        //     0,
        //     0,
        //     operatorAddress,
        //     0
        // )
        // expect(await muLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
        // // Add WOOF/TUSD liquidity
        // await pancakeRouter.connect(operator).addLiquidity(
        //     woof.address,
        //     tusd.address,
        //     ethers.utils.parseUnits("1000000"),
        //     ethers.utils.parseUnits("1000000"),
        //     0,
        //     0,
        //     operatorAddress,
        //     0
        // )
        // expect(await wuLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
        // Add MEOW/WBNB liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            meow.address,
            wbnb.address,
            ethers.utils.parseUnits("3000"),
            ethers.utils.parseUnits("3000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await mbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("6000"))
        // Add WOOF/TUSD liquidity
        await pancakeRouter.connect(operator).addLiquidity(
            woof.address,
            wbnb.address,
            ethers.utils.parseUnits("3000"),
            ethers.utils.parseUnits("3000"),
            0,
            0,
            operatorAddress,
            0
        )
        expect(await wbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("6000"))


        // Two token setting
        // isThreeTokenSetting = false
        // token0 = meow
        // token1 = woof
        // lpToken = mwLP
        // rewardToken = woof

        // Three token setting
        isThreeTokenSetting = true
        token0 = meow
        // token1 = tusd
        // lpToken = muLP
        token1 = wbnb
        lpToken = mbLP
        rewardToken = woof

        stakingRewards = await (
            await ethers.getContractFactory("StakingRewards", operator)
        ).deploy(
            operatorAddress,
            ownerAddr,
            rewardToken.address,
            lpToken.address
        )
        expect(await stakingRewards.callStatic.owner()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsDistribution()).to.equal(ownerAddr)
        expect(await stakingRewards.callStatic.rewardsToken()).to.equal(rewardToken.address)
        expect(await stakingRewards.callStatic.stakingToken()).to.equal(lpToken.address)

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
            await ethers.getContractFactory("TempStakeManager", operator)
        ).deploy()
        tempStakeManager = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            tempStakeManagerImpl.address,
            "0x"
        )
        tempStakeManager = tempStakeManagerImpl.attach(tempStakeManager.address)

        const betName = "MEOW/WOOF Bet"
        betImpl = await (
            await ethers.getContractFactory("Bet", operator)
        ).deploy()
        const betInitData = betImpl.interface.encodeFunctionData("initialize", [
            betName,
            ownerAddr,
            lpToken.address,
            converter.address,
            stakingRewards.address,
            operatorAddress,
            liquidityProviderAddress,
            tempStakeManager.address,
            penaltyPercentage
        ])
        bet = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            betImpl.address,
            betInitData
        )
        // Change Bet instance ABI from UpgradeProxy to Bet implementation
        bet = betImpl.attach(bet.address)
        expect(await bet.callStatic.implementation()).to.equal(betImpl.address)
        expect(await bet.callStatic.name()).to.equal(betName)
        expect(await bet.callStatic.converter()).to.equal(converter.address)
        expect(await bet.callStatic.token0()).to.equal(token0.address)
        expect(await bet.callStatic.token1()).to.equal(token1.address)
        expect(await bet.callStatic.operator()).to.equal(operatorAddress)
        expect(await bet.callStatic.liquidityProvider()).to.equal(liquidityProviderAddress)
        expect(await bet.callStatic.tempStakeManager()).to.equal(tempStakeManager.address)
        expect(await bet.callStatic.penaltyPercentage()).to.equal(penaltyPercentage)

        // Initialize TempStakeManager
        await tempStakeManager.initialize(
            tempStakeManagerName,
            operatorAddress,
            lpToken.address,
            converter.address,
            stakingRewards.address,
            bet.address
        )
        expect(await tempStakeManager.callStatic.implementation()).to.equal(tempStakeManagerImpl.address)
        expect(await tempStakeManager.callStatic.name()).to.equal(tempStakeManagerName)
        expect(await tempStakeManager.callStatic.token0()).to.equal(token0.address)
        expect(await tempStakeManager.callStatic.token1()).to.equal(token1.address)
        expect(await tempStakeManager.callStatic.converter()).to.equal(converter.address)
        expect(await tempStakeManager.callStatic.owner()).to.equal(operatorAddress)
        expect(await tempStakeManager.callStatic.mainContract()).to.equal(bet.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('100')})
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        // await tusd.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await wbnb.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))
        // Transfer LP tokens to owner
        await mwLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        // await muLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        // await wuLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))
        await mbLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))
        await wbLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("1000"))

        // Owner add rewards to StakingRewards
        const newRewardAmount = ethers.utils.parseUnits('100000')
        await rewardToken.connect(operator).transfer(ownerAddr, newRewardAmount)
        await rewardToken.connect(owner).transfer(stakingRewards.address, newRewardAmount)
        const tx = await stakingRewards.connect(owner).notifyRewardAmount(newRewardAmount)
        expect(tx).to.emit(stakingRewards, "RewardAdded")
    })

    it("Should not re-initialize", async () => {
        const betName = "BLABLABLA"
        await expect(bet.connect(user).initialize(
            betName,
            receiverAddress,
            lpToken.address,
            converter.address,
            stakingRewards.address,
            operatorAddress,
            liquidityProviderAddress,
            tempStakeManager.address,
            penaltyPercentage
        )).to.be.revertedWith("Already initialized")

        const tempStakeManagerName = "BLABLABLA"
        await expect(tempStakeManager.connect(user).initialize(
            tempStakeManagerName,
            operatorAddress,
            lpToken.address,
            converter.address,
            stakingRewards.address,
            bet.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(bet.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")

        await expect(tempStakeManager.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with Token0", async () => {
        // const userToken0BalanceBefore = await token0.callStatic.balanceOf(userAddr)
        // expect(userToken0BalanceBefore).to.be.gt(0)
        // const userToken1BalanceBefore = await token1.callStatic.balanceOf(userAddr)
        // expect(userToken1BalanceBefore).to.be.gt(0)
        const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)

        const betLPBalanceBefore = await lpToken.callStatic.balanceOf(bet.address)
        expect(betLPBalanceBefore).to.equal(0)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

        const stakeAmount = ethers.utils.parseUnits('100')
        await token0.connect(user).approve(bet.address, stakeAmount)

        const isToken0 = true
        const tx = await bet.connect(user).stake(isToken0, stakeAmount, minReceivedToken1Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedBonus = await bet.callStatic.earned(userAddr)
        expect(earnedBonus).to.equal(0)
        // Should not accrue any LP tokens in Bet contract
        const betLPBalanceAfter = await lpToken.callStatic.balanceOf(bet.address)
        expect(betLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        const stakedAmount = betStakeBalanceAfter.sub(betStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with Token1", async () => {
        // const userToken0BalanceBefore = await token0.callStatic.balanceOf(userAddr)
        // expect(userToken0BalanceBefore).to.be.gt(0)
        // const userToken1BalanceBefore = await token1.callStatic.balanceOf(userAddr)
        // expect(userToken1BalanceBefore).to.be.gt(0)

        // const betLPBalanceBefore = await lpToken.callStatic.balanceOf(bet.address)
        // expect(betLPBalanceBefore).to.equal(0)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        // const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(bet.address, stakeAmount)

        const isToken0 = false
        const tx = await bet.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        // const betLPBalanceAfter = await lpToken.callStatic.balanceOf(bet.address)
        // expect(betLPBalanceAfter).to.equal(0)
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        const stakedAmount = betStakeBalanceAfter.sub(betStakeBalanceBefore)
        // expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        // expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

        // LP token amount
        const stakeAmount = ethers.utils.parseUnits('1')
        await lpToken.connect(user).approve(bet.address, stakeAmount)

        const tx = await bet.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        const stakedAmount = betStakeBalanceAfter.sub(betStakeBalanceBefore)
        expect(stakedAmount).to.equal(stakeAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with native token", async () => {
        if (token0.address == wbnb.address || token1.address == wbnb.address) {
            const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

            const stakeAmount = ethers.utils.parseUnits('1')
            const tx = await bet.connect(user).stakeWithNative(minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount,
                {
                    value: stakeAmount
                }
            )
            const receipt = await tx.wait()

            // const betLPBalanceAfter = await lpToken.callStatic.balanceOf(bet.address)
            // expect(betLPBalanceAfter).to.equal(0)
            const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
            // const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
            const stakedAmount = betStakeBalanceAfter.sub(betStakeBalanceBefore)
            // expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
            // expect(stakedAmount).to.be.gt(0)

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
        const earnedBonusBefore = await bet.callStatic.earned(userAddr)
        expect(earnedBonusBefore).to.equal(0)

        ffSeconds = 1000
        await fastforward(ffSeconds)

        const earnedBonusAfter = await bet.callStatic.earned(userAddr)
        expect(earnedBonusAfter).to.equal(earnedBonusBefore)
    })

    it("Should cook", async () => {
        const operatorRewardAmountBefore = await rewardToken.callStatic.balanceOf(operatorAddress)
        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)

        const totalSupplyBefore = await bet.callStatic.totalSupply()
        const bonusBefore = await bet.callStatic.bonus()
        const totalRewardShareBefore = await bet.callStatic._shareTotal()
        const totalEarnedBonusBefore = await bet.callStatic.earned(bet.address)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        const betEarnedRewardsBefore = await stakingRewards.callStatic.earned(bet.address)
        // Should have accrued reward
        expect(betEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(betEarnedRewardsBefore)
        // Should not earn any bonus before cook
        expect(totalEarnedBonusBefore).to.equal(0)

        // User's reward locked as StakingRewards reward should not be zero
        const userEarnedLockedRewardsBefore = await bet.callStatic.earnedLocked(userAddr)
        expect(userEarnedLockedRewardsBefore).to.be.gt(0)

        const tx = await bet.connect(operator).cook()

        // Operator should receive rewards
        const operatorRewardAmountAfter = await rewardToken.callStatic.balanceOf(operatorAddress)
        expect(operatorRewardAmountAfter).to.be.gt(operatorRewardAmountBefore)
        // expect(tx).to.emit(bet, "Cook").withArgs(betEarnedRewardsBefore)
        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)
        // Should send away all reward
        expect(betRewardBalanceAfter).to.equal(0)

        // Should not change total supply
        const totalSupplyAfter = await bet.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should not change bonus amount
        const bonusAfter = await bet.callStatic.bonus()
        expect(bonusAfter).to.equal(bonusBefore)
        // Should not change Bet balance 
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)
        const totalEarnedBonusAfter = await bet.callStatic.earned(bet.address)
        // Should not earn any bonus after cook
        expect(totalEarnedBonusAfter).to.equal(0)

        // User's reward locked as StakingRewards reward should be zero after cook
        const userEarnedLockedRewardsAfter = await bet.callStatic.earnedLocked(userAddr)
        expect(userEarnedLockedRewardsAfter).to.equal(0)

        const cookedRewardAmount = betRewardBalanceBefore.sub(betRewardBalanceAfter).add(betEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should transfer stake to TempStakeManager when staking in Lock state", async () => {
        const userTempStkBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkBalanceBefore).to.equal(0)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        const tempStkMgrStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(bet.address, stakeAmount)

        const isToken0 = false
        const tx = await bet.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const userTempStkBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Bet stake balance should remain the same
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)
        const tempStkMgrStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)
        const stakedAmount = tempStkMgrStakeBalanceAfter.sub(tempStkMgrStakeBalanceBefore)
        expect(tempStkMgrStakeBalanceAfter.sub(tempStkMgrStakeBalanceBefore)).to.equal(stakedAmount)
        expect(userTempStkBalanceAfter.sub(userTempStkBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)
        expect(tx).to.emit(tempStakeManager, "Staked").withArgs(userAddr, stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP into TempStakeManager`)
    })

    it("Should serve", async () => {
        const userEarnedBonusBefore = await bet.callStatic.earned(userAddr)

        const totalSupplyBefore = await bet.callStatic.totalSupply()
        const totalEarnedBonusBefore = await bet.callStatic.earned(bet.address)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        // Should not earn any bonus before first serve
        expect(totalEarnedBonusBefore).to.equal(0)
        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)
        // Should have no reward before serve
        expect(betRewardBalanceBefore).to.equal(0)
        const periodBefore = await bet.callStatic.period()
        expect(periodBefore).to.equal(1)

        ffSeconds = 1000
        await fastforward(ffSeconds)

        const returnedRewardAmount = ethers.utils.parseUnits('1000')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await rewardToken.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // liquidityProvider approve Bet contract
        await rewardToken.connect(operator).approve(bet.address, returnedRewardAmount)
        const tx = await bet.connect(operator).serve(returnedRewardAmount)

        const periodAfter = await bet.callStatic.period()
        expect(periodAfter).to.equal(2)

        // User should earn bonus
        const userEarnedBonusAfter = await bet.callStatic.earned(userAddr)

        // Should not change total supply
        const totalSupplyAfter = await bet.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should update bonus amount 
        const bonusAfter = await bet.callStatic.bonus()
        expect(tx).to.emit(bet, "Serve").withArgs(returnedRewardAmount)
        // Should not change Bet balance 
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)
        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)
        expect(betRewardBalanceAfter).to.equal(returnedRewardAmount)
        // Should match bonus and reward balance
        expect(betRewardBalanceAfter).to.equal(bonusAfter)
        
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
        const userTempStkBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        const tempStkMgrStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)

        // Check user is in TempStakeManager staker list
        const numStakers = 1
        const stakerListBefore = await tempStakeManager.callStatic.getAllStakers()
        expect(stakerListBefore.length).to.equal(numStakers)
        expect(stakerListBefore[0]).to.equal(userAddr)

        const stakerIndex = 0
        const tx = await bet.connect(operator).transferStake(
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

        const userTempStkBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkBalanceAfter).to.equal(0)
        const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        const tempStkMgrStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)
        expect(tempStkMgrStakeBalanceAfter).to.equal(0)
        // Stake should be transferred from TempStakeManager to Bet, along with stake converted from reward
        expect(betStakeBalanceAfter.sub(betStakeBalanceBefore)).to.be.gte(tempStkMgrStakeBalanceBefore.sub(tempStkMgrStakeBalanceAfter))
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.be.gte(userTempStkBalanceBefore.sub(userTempStkBalanceAfter))
        const transferredStakeAmount = userTempStkBalanceBefore.sub(userTempStkBalanceAfter)
        expect(tx).to.emit(tempStakeManager, "Withdrawn").withArgs(userAddr, transferredStakeAmount)
        const convertedLPAmount = betStakeBalanceAfter.sub(betStakeBalanceBefore).sub(transferredStakeAmount)
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
        const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)

        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

        const withdrawAmount = ethers.utils.parseUnits('5')

        const token0Percentage = 100
        const tx = await bet.connect(user).withdraw(minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, withdrawAmount)
        const receipt = await tx.wait()

        const userToken0BalanceAfter = await token0.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userToken0BalanceAfter).to.be.gt(userToken0BalanceBefore)
        const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Should match Bet balance difference and user withdraw amount
        expect(betStakeBalanceBefore.sub(betStakeBalanceAfter)).to.equal(withdrawAmount)

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
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await bet.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        const withdrawnAmount = betStakeBalanceBefore.sub(betStakeBalanceAfter)
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
            const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)

            const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

            const withdrawAmount = ethers.utils.parseUnits('1')

            const tx = await bet.connect(user).withdrawWithNative(minReceivedToken0Amount, minReceivedToken1Amount, withdrawAmount)
            const receipt = await tx.wait()

            const userNativeTokenBalanceAfter = await user.getBalance()
            // Should receive withdrawal
            expect(userNativeTokenBalanceAfter).to.be.gt(userNativeTokenBalanceBefore)
            const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
            // Should match balance difference and withdraw amount
            expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

            const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
            // Should match Bet balance difference and user withdraw amount
            expect(betStakeBalanceBefore.sub(betStakeBalanceAfter)).to.equal(withdrawAmount)

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
        const userToken0BalanceBefore = await token0.callStatic.balanceOf(userAddr)
        const userRewardBalanceBefore = await rewardToken.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await bet.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await bet.callStatic._share(userAddr)
        const userEarnedBonusBefore = await bet.callStatic.earned(userAddr)

        const totalRewardShareBefore = await bet.callStatic._shareTotal()
        const totalEarnedBonusBefore = await bet.callStatic.earned(bet.address)
        const bonusBefore = await bet.callStatic.bonus()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBonusBefore).to.equal(totalEarnedBonusBefore)
        expect(totalEarnedBonusBefore).to.equal(bonusBefore)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        const betEarnedRewardsBefore = await stakingRewards.callStatic.earned(bet.address)
        const rewardBeforeCookAmountBefore = await bet.callStatic.rewardBeforeCook()
        // No getReward in Fund state before so rewardBeforeCook should be zero
        expect(rewardBeforeCookAmountBefore).to.equal(0)

        const token0Percentage = 100
        const getStakingRewardsReward = true
        const tx = await bet.connect(user)["getReward(uint256,uint256,bool)"](token0Percentage, minReceivedToken0Amount, getStakingRewardsReward)
        const receipt = await tx.wait()

        const userToken0BalanceAfter = await token0.callStatic.balanceOf(userAddr)
        const userRewardBalanceAfter = await rewardToken.callStatic.balanceOf(userAddr)
        // Should receive reward
        if (isThreeTokenSetting) {
            expect(userRewardBalanceAfter).to.be.gt(userRewardBalanceBefore)
        } else {
            expect(userToken0BalanceAfter).to.be.gt(userToken0BalanceBefore)
        }
        const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await bet.callStatic._share(userAddr)
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        const bonusAfter = await bet.callStatic.bonus()
        // Assume no one else staking: should have no rewards left
        expect(bonusAfter).to.equal(0)
        let receivedBonusAmount = bonusBefore.sub(bonusAfter)
        // Should receive bonus
        expect(receivedBonusAmount).to.be.gt(0)
        expect(receivedBonusAmount).to.equal(bonusBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))
        if (getStakingRewardsReward) {
            expect(tx).to.emit(bet, "StakingRewardsReward")
            const events = parseLogsByName(bet, "StakingRewardsReward", receipt.logs)
            const actualStakingRewardsReward = events[0].args.amount
            const expectedStakingRewardsReward = betEarnedRewardsBefore.add(rewardBeforeCookAmountBefore).mul(userRewardShareBefore).div(totalRewardShareBefore)
            expect(actualStakingRewardsReward).to.be.gte(expectedStakingRewardsReward)
            // Diff should be less than 1%
            console.log(`StakingRewards reward amount diff: ${actualStakingRewardsReward.sub(expectedStakingRewardsReward)}`)
            expect(actualStakingRewardsReward.sub(expectedStakingRewardsReward)).to.be.lt(actualStakingRewardsReward.div(100))
            receivedBonusAmount = receivedBonusAmount.add(actualStakingRewardsReward)
        }
        expect(tx).to.emit(bet, "RewardPaid").withArgs(userAddr, receivedBonusAmount)

        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Should not change total stake balance
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)

        const receivedBonus = ethers.utils.formatUnits(
            receivedBonusAmount,
            18
        )
        console.log(`Get ${receivedBonus} bonus`)
        const receivedToken0 = ethers.utils.formatUnits(
            userToken0BalanceAfter.sub(userToken0BalanceBefore),
            18
        )
        console.log(`Converted to ${receivedToken0} Token0`)
    })

    it("Should fail to getReward in same period", async () => {
        const token0Percentage = 100
        const getStakingRewardsReward = true
        await expect(
            bet.connect(user)["getReward(uint256,uint256,bool)"](
                token0Percentage, minReceivedToken0Amount, getStakingRewardsReward)
        ).to.be.revertedWith("Already getReward in this period")
    })

    it("Should cook", async () => {
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)
        const betEarnedRewardsBefore = await stakingRewards.callStatic.earned(bet.address)

        const tx = await bet.connect(operator).cook()

        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)

        const cookedRewardAmount = betRewardBalanceBefore.sub(betRewardBalanceAfter).add(betEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should serve", async () => {
        const userEarnedBonusBefore = await bet.callStatic.earned(userAddr)
        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)
        // Should have no reward before serve
        expect(betRewardBalanceBefore).to.equal(0)

        ffSeconds = 5000
        await fastforward(ffSeconds)

        const returnedRewardAmount = ethers.utils.parseUnits('1000')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await rewardToken.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // liquidityProvider approve Bet contract
        await rewardToken.connect(operator).approve(bet.address, returnedRewardAmount)
        const tx = await bet.connect(operator).serve(returnedRewardAmount)

        // User should earn bonus
        const userEarnedBonusAfter = await bet.callStatic.earned(userAddr)
        
        // Should update bonus amount 
        const bonusAfter = await bet.callStatic.bonus()
        // Should match bonus and reward balance
        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)
        expect(betRewardBalanceAfter).to.equal(returnedRewardAmount)
        expect(betRewardBalanceAfter).to.equal(bonusAfter)
        expect(tx).to.emit(bet, "Serve").withArgs(returnedRewardAmount)
        
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
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)
        const betEarnedRewardsBefore = await stakingRewards.callStatic.earned(bet.address)

        const tx = await bet.connect(operator).cook()

        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)

        const cookedRewardAmount = betRewardBalanceBefore.sub(betRewardBalanceAfter).add(betEarnedRewardsBefore)
        const rewards = ethers.utils.formatUnits(
            cookedRewardAmount,
            18
        )
        console.log(`Cook ${rewards} rewards`)
    })

    it("Should exit and convert to Token1 but user only get part of bonus", async () => {
        const frontRewardsAmount = ethers.utils.parseUnits("10000")
        // Transfer rewards to liquidityProvider because liquidityProvider does not have enough rewards to front the withdraw payment
        await rewardToken.connect(owner).transfer(liquidityProviderAddress, frontRewardsAmount)

        const userToken1BalanceBefore = await token1.callStatic.balanceOf(userAddr)
        const userStakeBefore = await bet.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await bet.callStatic._share(userAddr)
        const userEarnedBonusBefore = await bet.callStatic.earned(userAddr)

        const totalRewardShareBefore = await bet.callStatic._shareTotal()
        const totalEarnedBonusBefore = await bet.callStatic.earned(bet.address)
        const bonusBefore = await bet.callStatic.bonus()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBonusBefore).to.equal(totalEarnedBonusBefore)
        expect(totalEarnedBonusBefore).to.equal(bonusBefore)

        // Liquidity provider approve Bet contract to transfer rewards from him to front the withdraw payment
        await rewardToken.connect(liquidityProvider).approve(bet.address, MAX_INT)
        const token0Percentage = 0
        const tx = await bet.connect(user).exit(minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage)
        const receipt = await tx.wait()
        // Liquidity provider clear allowance
        await rewardToken.connect(liquidityProvider).approve(bet.address, 0)

        const userToken1alanceAfter = await token1.callStatic.balanceOf(userAddr)
        // Should receive withdrawal
        expect(userToken1alanceAfter).to.be.gt(userToken1BalanceBefore)
        const userStakeBalanceAfter = await bet.callStatic.balanceOf(userAddr)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await bet.callStatic._share(userAddr)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await bet.callStatic._shareTotal()
        const bonusAfter = await bet.callStatic.bonus()
        // Should be rewards left since part of bonus are given to operator
        expect(totalRewardShareAfter).to.be.gt(0)
        expect(bonusAfter).to.be.gt(0)
        const receivedBonusAmount = bonusBefore.sub(bonusAfter)
        // Should receive bonus tokens
        expect(receivedBonusAmount).to.be.gt(0)
        expect(tx).to.emit(bet, "RewardPaid").withArgs(userAddr, receivedBonusAmount)
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
        const liquidityProviderRewardShareAfter = await bet.callStatic._share(liquidityProviderAddress)
        expect(liquidityProviderRewardShareAfter).to.equal(totalRewardShareAfter)
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Assume no one else staking: should be no Bet balance left
        expect(betStakeBalanceAfter).to.equal(0)

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
        const userTempStkBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkBalanceBefore).to.equal(0)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)
        const tempStkMgrStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)

        const stakeAmount = ethers.utils.parseUnits('100')
        await token1.connect(user).approve(bet.address, stakeAmount)

        const isToken0 = false
        const tx = await bet.connect(user).stake(isToken0, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        const userTempStkBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Bet stake balance should remain the same
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)
        const tempStkMgrStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(tempStakeManager.address)
        const stakedAmount = tempStkMgrStakeBalanceAfter.sub(tempStkMgrStakeBalanceBefore)
        expect(tempStkMgrStakeBalanceAfter.sub(tempStkMgrStakeBalanceBefore)).to.equal(stakedAmount)
        expect(userTempStkBalanceAfter.sub(userTempStkBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)
        expect(tx).to.emit(tempStakeManager, "Staked").withArgs(userAddr, stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP into TempStakeManager`)
    })

    it("Should abort user from TempStakeManager", async () => {
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const userRewardBalanceBefore = await rewardToken.callStatic.balanceOf(userAddr)
        const userMWLPBalanceBefore = await lpToken.callStatic.balanceOf(userAddr)
        const userTempStkEarnedBefore = await tempStakeManager.callStatic.earned(userAddr)
        const userTempStkBalanceBefore = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkBalanceBefore).to.be.gt(0)
        const betStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(bet.address)

        const tx = await bet.connect(operator).abortFromTempStakeManager([userAddr])
        const receipt = await tx.wait()

        const userRewardBalanceAfter = await rewardToken.callStatic.balanceOf(userAddr)
        const userMWLPBalanceAfter = await lpToken.callStatic.balanceOf(userAddr)
        const userTempStkBalanceAfter = await tempStakeManager.callStatic.balanceOf(userAddr)
        expect(userTempStkBalanceAfter).to.equal(0)
        const returnedLPAmount = userMWLPBalanceAfter.sub(userMWLPBalanceBefore)
        expect(returnedLPAmount).to.equal(userTempStkBalanceBefore.sub(userTempStkBalanceAfter))
        const betStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(bet.address)
        // Bet stake balance should remain the same
        expect(betStakeBalanceAfter).to.equal(betStakeBalanceBefore)
        expect(userTempStkBalanceAfter).to.equal(0)
        const userEarnedRewardAmount = userRewardBalanceAfter.sub(userRewardBalanceBefore)
        expect(userEarnedRewardAmount).to.be.gte(userTempStkEarnedBefore)
        expect(tx).to.emit(tempStakeManager, "Abort").withArgs(userAddr, userTempStkBalanceBefore)
        expect(tx).to.emit(tempStakeManager, "RewardPaid").withArgs(userAddr, userEarnedRewardAmount)

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
        const userEarnedBonusBefore = await bet.callStatic.earned(userAddr)
        const betRewardBalanceBefore = await rewardToken.callStatic.balanceOf(bet.address)
        // Should have no reward before serve
        expect(betRewardBalanceBefore).to.equal(0)

        const returnedRewardAmount = ethers.utils.parseUnits('10')
        // Transfer rewards to operator because operator does not have enough rewards to serve
        await rewardToken.connect(owner).transfer(operatorAddress, returnedRewardAmount)
        // liquidityProvider approve Bet contract
        await rewardToken.connect(operator).approve(bet.address, returnedRewardAmount)
        const tx = await bet.connect(operator).serve(returnedRewardAmount)

        // User should earn bonus
        const userEarnedBonusAfter = await bet.callStatic.earned(userAddr)
        
        // Should update bonus amount 
        const bonusAfter = await bet.callStatic.bonus()
        // Should match bonus and reward balance
        const betRewardBalanceAfter = await rewardToken.callStatic.balanceOf(bet.address)
        expect(betRewardBalanceAfter).to.equal(returnedRewardAmount)
        expect(betRewardBalanceAfter).to.equal(bonusAfter)
        expect(tx).to.emit(bet, "Serve").withArgs(returnedRewardAmount)
        
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
        const lpRewardBalanceBefore = await rewardToken.callStatic.balanceOf(liquidityProviderAddress)
        const earnedBonusBefore = await bet.callStatic.earned(liquidityProviderAddress)
        expect(earnedBonusBefore).to.be.gt(0)
        const bonusBefore = await bet.callStatic.bonus()
        expect(bonusBefore).to.be.gt(0)

        await bet.connect(liquidityProvider).liquidityProviderGetBonus()

        const earnedBonusAfter = await bet.callStatic.earned(liquidityProviderAddress)
        expect(earnedBonusAfter).to.equal(0)
        const bonusAfter = await bet.callStatic.bonus()
        expect(bonusAfter).to.equal(0)
        const lpRewardBalanceAfter = await rewardToken.callStatic.balanceOf(liquidityProviderAddress)
        expect(lpRewardBalanceAfter.sub(lpRewardBalanceBefore)).to.equal(bonusBefore.sub(bonusAfter))

        const receivedBonusAmount = earnedBonusBefore.sub(earnedBonusAfter)
        const receivedBonus = ethers.utils.formatUnits(
            receivedBonusAmount,
            18
        )
        console.log(`Liquidity provider get ${receivedBonus} Reward`)
    })
})