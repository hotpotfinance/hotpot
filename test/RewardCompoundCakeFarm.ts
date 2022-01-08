import { expect } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { mineBlocks } from "./utils/network"

describe("RewardCompoundCakeFarm", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddr: string
    let masterChefOwner: Signer

    // Contracts
    let woof: Contract, meow: Contract, mwLP: Contract
    let bcnt: Contract, mbLP: Contract, wbLP: Contract
    let cake: Contract, cbLP: Contract
    let pancakeRouter: Contract
    let masterChef: Contract
    let poolId: BigNumber, cakerPerBlock: BigNumber
    let stakingRewards: Contract
    let converterImpl: Contract
    let converter: Contract
    let rewardCompoundImpl: Contract
    let rewardCompound: Contract

    const MAX_INT = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

    const tbnbAddr = "0x509Ba9040dc4091da93f07cdD1e03Dea208e28bf"
    const wbnbAddr = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
    const woofAddr = "0x8dEdf46654B5A8d87a16D92C86ABB769578455B3"
    const meowAddr = "0x505A32c45676777e94689D16F30Df2a0Fa5dBa8e"
    const mwLPAddr = "0x304D9a9969Ea753b1A5d4eB9F3542cb870f4a843"
    const cakeAddr = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"
    const cmLPAddr = "0x36f3FCB0A2Fc61959CB11D59FC00cB8ac9Cc7d52"
    const pancakeRouterAddr = "0x10ED43C718714eb63d5aA57B78B54704E256024E"
    const masterChefAddr = "0x73feaa1eE314F8c655E354234017bE2193C9E24E"
    const masterChefOwnerAddr = "0xA1f482Dc58145Ba2210bC21878Ca34000E2e8fE4"

    const ownerAddr = "0xb0123A6B61F0b5500EA92F33F24134c814364e3a"

    let numFFBlocks
    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedLPAmount = 0

    before(async () => {
        [receiver, operator] = await ethers.getSigners()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()


        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [ownerAddr]
        })

        owner = ethers.provider.getSigner(ownerAddr)
        user = owner
        userAddr = ownerAddr

        // Use fork mainnet state
        // woof = await ethers.getContractAt("mintersBEP2EToken", woofAddr)
        // expect(await woof.totalSupply()).gt(0)
        // meow = await ethers.getContractAt("mintersBEP2EToken", meowAddr)
        // expect(await meow.totalSupply()).gt(0)
        // mwLP = await ethers.getContractAt("mintersBEP2EToken", mwLPAddr)
        // expect(await mwLP.totalSupply()).gt(0)
        // cake = await ethers.getContractAt("mintersBEP2EToken", cakeAddr)
        // expect(await cake.totalSupply()).gt(0)
        // cmLP = await ethers.getContractAt("mintersBEP2EToken", cmLPAddr)
        // expect(await cmLP.totalSupply()).gt(0)
        // pancakeRouter = await ethers.getContractAt("IPancakeRouter", pancakeRouterAddr)

        // Deploy new contracts for testing
        const deciaml = 18
        const initSupply = ethers.utils.parseUnits("10000000")
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
        cbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(cake.address, bcnt.address)
        mbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(meow.address, bcnt.address)
        wbLP = await (
            await ethers.getContractFactory("StubPancakePair", operator)
        ).deploy(woof.address, bcnt.address)

        pancakeRouter = await (
            await ethers.getContractFactory("StubPancakeRouter", operator)
        ).deploy()
        await pancakeRouter.setLPAddr(meow.address, woof.address, mwLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, woof.address)).to.equal(mwLP.address)
        await pancakeRouter.setLPAddr(cake.address, bcnt.address, cbLP.address)
        expect(await pancakeRouter.lpAddr(cake.address, bcnt.address)).to.equal(cbLP.address)
        await pancakeRouter.setLPAddr(woof.address, bcnt.address, wbLP.address)
        expect(await pancakeRouter.lpAddr(woof.address, bcnt.address)).to.equal(wbLP.address)
        await pancakeRouter.setLPAddr(meow.address, bcnt.address, mbLP.address)
        expect(await pancakeRouter.lpAddr(meow.address, bcnt.address)).to.equal(mbLP.address)

        // Add liquidity
        await cake.connect(operator).approve(pancakeRouter.address, MAX_INT)
        await bcnt.connect(operator).approve(pancakeRouter.address, MAX_INT)
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
        expect(await mbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))
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
        expect(await wbLP.callStatic.balanceOf(operatorAddress)).to.equal(ethers.utils.parseUnits("2000000"))

        // Set up MasterChef pool
        poolId = BigNumber.from(1)
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
        // Add Cake to MasterChef
        await cake.connect(operator).transfer(masterChef.address, ethers.utils.parseUnits("1000000"))

        // Set up StakingRewards
        stakingRewards = await (
            await ethers.getContractFactory("StakingRewards", operator)
        ).deploy(
            operatorAddress,
            ownerAddr,
            bcnt.address,
            bcnt.address
        )
        expect(await stakingRewards.callStatic.owner()).to.equal(operatorAddress)
        expect(await stakingRewards.callStatic.rewardsDistribution()).to.equal(ownerAddr)
        expect(await stakingRewards.callStatic.rewardsToken()).to.equal(bcnt.address)
        expect(await stakingRewards.callStatic.stakingToken()).to.equal(bcnt.address)

        const converterName = "Token Converter"
        converterImpl = await (
            await ethers.getContractFactory("Converter", operator)
        ).deploy()
        const converterInitData = converterImpl.interface.encodeFunctionData("initialize", [
            tbnbAddr, // Native token
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

        const rewardCompoundName = "MEOW/WOOF RewardCompoundCakeFarm"
        rewardCompoundImpl = await (
            await ethers.getContractFactory("RewardCompoundCakeFarm", operator)
        ).deploy()
        const acInitData = rewardCompoundImpl.interface.encodeFunctionData("initialize", [
            rewardCompoundName,
            operatorAddress,
            operatorAddress,
            bcnt.address,
            cake.address,
            poolId,
            mwLP.address,
            converter.address,
            masterChef.address,
            stakingRewards.address
        ])
        rewardCompound = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            rewardCompoundImpl.address,
            acInitData
        )
        // Change RewardCompoundCakeFarm instance ABI from UpgradeProxy to RewardCompoundCakeFarm implementation
        rewardCompound = rewardCompoundImpl.attach(rewardCompound.address)
        expect(await rewardCompound.callStatic.implementation()).to.equal(rewardCompoundImpl.address)
        expect(await rewardCompound.callStatic.name()).to.equal(rewardCompoundName)
        expect(await rewardCompound.callStatic.operator()).to.equal(operatorAddress)
        expect(await rewardCompound.callStatic.BCNT()).to.equal(bcnt.address)
        expect(await rewardCompound.callStatic.cake()).to.equal(cake.address)
        expect(await rewardCompound.callStatic.pid()).to.equal(poolId)
        expect(await rewardCompound.callStatic.token0()).to.equal(meow.address)
        expect(await rewardCompound.callStatic.token1()).to.equal(woof.address)
        expect(await rewardCompound.callStatic.converter()).to.equal(converter.address)
        expect(await rewardCompound.callStatic.masterChef()).to.equal(masterChef.address)
        expect(await rewardCompound.callStatic.stakingRewards()).to.equal(stakingRewards.address)
        expect(await rewardCompound.callStatic.stakingRewardsStakingToken()).to.equal(bcnt.address)
        expect(await rewardCompound.callStatic.stakingRewardsRewardsToken()).to.equal(bcnt.address)

        // Transfer ether to owner
        await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})
        // Transfer tokens to owner
        await meow.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        await woof.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("100000"))
        // Transfer LP tokens to owner
        await mwLP.connect(operator).transfer(ownerAddr, ethers.utils.parseUnits("20000"))

        // Owner add rewards to StakingRewards
        const newRewardAmount = ethers.utils.parseUnits('100000')
        await bcnt.connect(operator).transfer(ownerAddr, newRewardAmount)
        await bcnt.connect(owner).transfer(stakingRewards.address, newRewardAmount)
        const tx = await stakingRewards.connect(owner).notifyRewardAmount(newRewardAmount)
        expect(tx).to.emit(stakingRewards, "RewardAdded")
    })

    it("Should not re-initialize", async () => {
        const rewardCompoundName = "BLABLABLA"
        await expect(rewardCompound.connect(user).initialize(
            rewardCompoundName,
            receiverAddress,
            receiverAddress,
            bcnt.address,
            cake.address,
            poolId,
            mwLP.address,
            converter.address,
            masterChef.address,
            stakingRewards.address
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(rewardCompound.connect(receiver).upgradeTo(
            pancakeRouter.address
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with MEOW", async () => {
        // const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        // expect(userMEOWBalanceBefore).to.be.gt(0)
        // const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        // expect(userWOOFBalanceBefore).to.be.gt(0)
        const userStakeBalanceBefore = await rewardCompound.callStatic.balanceOf(userAddr)

        const rewardCompoundLPBalanceBefore = await mwLP.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundLPBalanceBefore).to.equal(0)
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]

        const stakeAmount = ethers.utils.parseUnits("100")
        await meow.connect(user).approve(rewardCompound.address, stakeAmount)

        const isMEOW = true
        const tx = await rewardCompound.connect(user).stake(isMEOW, stakeAmount, minReceivedToken1Amount, minReceivedToken1Amount, minReceivedToken0Amount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedLPAmount = await rewardCompound.callStatic.earned(userAddr)
        expect(earnedLPAmount).to.equal(0)
        // Should not accrue any LP tokens in RewardCompoundCakeFarm contract
        const rewardCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const stakedAmount = rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with WOOF", async () => {
        // const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        // expect(userMEOWBalanceBefore).to.be.gt(0)
        // const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        // expect(userWOOFBalanceBefore).to.be.gt(0)

        // const rewardCompoundLPBalanceBefore = await mwLP.callStatic.balanceOf(rewardCompound.address)
        // expect(rewardCompoundLPBalanceBefore).to.equal(0)
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        // const userStakeBalanceBefore = await rewardCompound.callStatic.balanceOf(userAddr)

        const stakeAmount = ethers.utils.parseUnits("100")
        await woof.connect(user).approve(rewardCompound.address, stakeAmount)

        const isMEOW = false
        const tx = await rewardCompound.connect(user).stake(isMEOW, stakeAmount, minReceivedToken0Amount, minReceivedToken0Amount, minReceivedToken1Amount)
        const receipt = await tx.wait()

        // const rewardCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(rewardCompound.address)
        // expect(rewardCompoundLPBalanceAfter).to.equal(0)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        // const userStakeBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        const stakedAmount = rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)
        // expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        // expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]

        // LP token amount
        const stakeAmount = ethers.utils.parseUnits('1')
        await mwLP.connect(user).approve(rewardCompound.address, stakeAmount)

        const tx = await rewardCompound.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const stakedAmount = rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should not earned before compound", async () => {
        const earnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)
        expect(earnedLPAmountBefore).to.equal(0)

        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const earnedLPAmountAfter = await rewardCompound.callStatic.earned(userAddr)
        expect(earnedLPAmountAfter).to.equal(earnedLPAmountBefore)
    })

    it("Should compound for the first time, no LP amount compounded because no rewards accrued yet in StakingRewards", async () => {
        const userBalanceBefore = await rewardCompound.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)

        const totalSupplyBefore = await rewardCompound.callStatic.totalSupply()
        const lpAmountCompoundedBefore = await rewardCompound.callStatic.lpAmountCompounded()
        const totalRewardShareBefore = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await rewardCompound.callStatic.earned(rewardCompound.address)
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const rewardCompoundEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)
        // Should have accrued reward to compound
        expect(rewardCompoundEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        // Should not earn any LP tokens before compound
        expect(userEarnedLPAmountBefore).to.equal(0)
        expect(totalEarnedLPAmountBefore).to.equal(0)
        // Should have no stake in StakingRewards yet
        const rewardCompoundStakingRewardsStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsStakeBalanceBefore).to.equal(0)
        // Should have no rewards in StakingRewards yet
        const rewardCompoundStakingRewardsEarnedRewardsBefore = await stakingRewards.callStatic.earned(rewardCompound.address)
        expect(rewardCompoundStakingRewardsEarnedRewardsBefore).to.equal(0)

        const tx = await rewardCompound.connect(operator).compound(
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )

        // Should not change User's balance and total supply
        const userBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        expect(userBalanceAfter).to.equal(userBalanceBefore)
        const totalSupplyAfter = await rewardCompound.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should not have compounded LP yet
        const lpAmountCompoundedAfter = await rewardCompound.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.equal(0)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        expect(rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)).to.equal(compoundedAmount)
        // Should be no cake left in MasterChef
        const rewardCompoundEarnedRewardsAfter = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)
        expect(rewardCompoundEarnedRewardsAfter).to.equal(0)
        const userRewardShareAfter = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountAfter = await rewardCompound.callStatic.earned(userAddr)
        const totalRewardShareAfter = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountAfter = await rewardCompound.callStatic.earned(rewardCompound.address)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareAfter).to.equal(userRewardShareAfter)
        // Should not have rewards yet
        expect(userEarnedLPAmountAfter).to.equal(0)
        expect(totalEarnedLPAmountAfter).to.equal(0)
        // Should have stake in StakingRewards
        const rewardCompoundStakingRewardsStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsStakeBalanceAfter).to.be.gt(0)
        // Should have no rewards left in StakingRewards
        const rewardCompoundStakingRewardsEarnedRewardsAfter = await stakingRewards.callStatic.earned(rewardCompound.address)
        expect(rewardCompoundStakingRewardsEarnedRewardsAfter).to.equal(0)

        const cakeAmount = rewardCompoundEarnedRewardsBefore
        const cake = ethers.utils.formatUnits(
            cakeAmount,
            18
        )
        const stakingTokenAmount = rewardCompoundStakingRewardsStakeBalanceAfter.sub(rewardCompoundStakingRewardsStakeBalanceBefore)
        const stakingToken = ethers.utils.formatUnits(
            stakingTokenAmount,
            18
        )
        const rewardsAmount = rewardCompoundStakingRewardsEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const compounded = ethers.utils.formatUnits(
            compoundedAmount,
            18
        )
        console.log(`Staked ${stakingToken} staking token with ${cake} cake`)
        console.log(`Compounded ${compounded} LP with ${rewards} reward token (should have no compounded LP because no reward has accured yet)`)
    })

    it("Should NOT earned after first compound", async () => {
        const earnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)

        const earnedRewards = ethers.utils.formatUnits(
            earnedLPAmountBefore,
            18
        )
        console.log(`Earned ${earnedRewards} rewards in ${numFFBlocks} blocks`)
    })

    it("Should withdraw and convert to MEOW ", async () => {
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddr)
        const userMEOWBalanceBefore = await meow.callStatic.balanceOf(userAddr)
        const userStakeBalanceBefore = await rewardCompound.callStatic.balanceOf(userAddr)
        
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const rewardCompoundStakingRewardsBalanceBefore = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsBalanceBefore).to.be.gt(0)

        const withdrawAmount = ethers.utils.parseUnits("5")

        const token0Percentage = 100
        const tx = await rewardCompound.connect(user).withdraw(minReceivedToken0Amount, minReceivedToken1Amount, token0Percentage, withdrawAmount)
        const receipt = await tx.wait()

        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddr)
        // Should receive BCNT
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userMEOWBalanceAfter = await meow.callStatic.balanceOf(userAddr)
        // Should receive reward
        expect(userMEOWBalanceAfter).to.be.gt(userMEOWBalanceBefore)
        const userStakeBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const totalEarnedLPAmountAfter = await rewardCompound.callStatic.earned(rewardCompound.address)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        // Should match RewardCompoundCakeFarm balance difference and user withdraw amount
        expect(rewardCompoundStakeBalanceBefore.sub(rewardCompoundStakeBalanceAfter)).to.equal(withdrawAmount)
        // Assume no one else staking: RewardCompoundCakeFarm balance should be the same as user balance plus total compounded LP amount
        expect(rewardCompoundStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))
        const rewardCompoundStakingRewardsBalanceAfter = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsBalanceAfter).to.be.lt(rewardCompoundStakingRewardsBalanceBefore)
        const amountWithdrawnFromStakingRewards = rewardCompoundStakingRewardsBalanceBefore.sub(rewardCompoundStakingRewardsBalanceAfter)
        expect(tx).to.emit(rewardCompound, "Withdrawn").withArgs(userAddr, withdrawAmount, amountWithdrawnFromStakingRewards)

        const withdrew = ethers.utils.formatUnits(
            withdrawAmount,
            18
        )

        console.log(`Withdrew ${withdrew} LP`)
        const receivedMEOW = ethers.utils.formatUnits(
            userMEOWBalanceAfter.sub(userMEOWBalanceBefore),
            18
        )
        console.log(`Converted LP to ${receivedMEOW} MEOW`)
        const receivedBCNT = ethers.utils.formatUnits(
            userBCNTBalanceAfter.sub(userBCNTBalanceBefore),
            18
        )
        console.log(`Also withdrew ${receivedBCNT} BCNT from StakingRewards`)
    })

    it("Should withdraw with LP Token", async () => {
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await rewardCompound.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const withdrawnAmount = rewardCompoundStakeBalanceBefore.sub(rewardCompoundStakeBalanceAfter)
        expect(withdrawnAmount).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
    })


    it("Should compound again and get compounded LP", async () => {
        // Fast forward to accrue some rewards
        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const userRewardShareBefore = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)

        const lpAmountCompoundedBefore = await rewardCompound.callStatic.lpAmountCompounded()
        const totalRewardShareBefore = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await rewardCompound.callStatic.earned(rewardCompound.address)
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const rewardCompoundEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)
        // Should have accrued reward to compound
        expect(rewardCompoundEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        // Should not have earned any LP
        expect(userEarnedLPAmountBefore).to.equal(0)
        expect(totalEarnedLPAmountBefore).to.equal(0)
        // Should have stake in StakingRewards
        const rewardCompoundStakingRewardsStakeBalanceBefore = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsStakeBalanceBefore).to.be.gt(0)
        // Should have rewards in StakingRewards
        const rewardCompoundStakingRewardsEarnedRewardsBefore = await stakingRewards.callStatic.earned(rewardCompound.address)
        expect(rewardCompoundStakingRewardsEarnedRewardsBefore).to.be.gt(0)

        const tx = await rewardCompound.connect(operator).compound(
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )

        // Should have compounded LP
        const lpAmountCompoundedAfter = await rewardCompound.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        expect(rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)).to.equal(compoundedAmount)
        // Should be no cake left in MasterChef
        const rewardCompoundEarnedRewardsAfter = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)
        expect(rewardCompoundEarnedRewardsAfter).to.equal(0)
        const userRewardShareAfter = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountAfter = await rewardCompound.callStatic.earned(userAddr)
        const totalRewardShareAfter = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountAfter = await rewardCompound.callStatic.earned(rewardCompound.address)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareAfter).to.equal(userRewardShareAfter)
        // Should have rewards
        // Assume no one else staking: user earned LP amount should be the same as total earned LP amount
        expect(totalEarnedLPAmountAfter).to.equal(userEarnedLPAmountAfter)
        // Should match total earned LP amount and compounded amount
        expect(totalEarnedLPAmountAfter).to.equal(compoundedAmount)
        // Should have stake in StakingRewards
        const rewardCompoundStakingRewardsStakeBalanceAfter = await stakingRewards.callStatic.balanceOf(rewardCompound.address)
        expect(rewardCompoundStakingRewardsStakeBalanceAfter).to.be.gt(rewardCompoundStakingRewardsStakeBalanceBefore)
        const stakingTokenAmount = rewardCompoundStakingRewardsStakeBalanceAfter.sub(rewardCompoundStakingRewardsStakeBalanceBefore)
        expect(tx).to.emit(rewardCompound, "StakedToStakingReward").withArgs(stakingTokenAmount)
        // Should have no rewards left in StakingRewards
        const rewardCompoundStakingRewardsEarnedRewardsAfter = await stakingRewards.callStatic.earned(rewardCompound.address)
        expect(rewardCompoundStakingRewardsEarnedRewardsAfter).to.equal(0)

        const cakeAmount = rewardCompoundEarnedRewardsBefore
        const cake = ethers.utils.formatUnits(
            cakeAmount,
            18
        )
        const stakingToken = ethers.utils.formatUnits(
            stakingTokenAmount,
            18
        )
        const rewardsAmount = rewardCompoundStakingRewardsEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const compounded = ethers.utils.formatUnits(
            compoundedAmount,
            18
        )
        console.log(`Staked ${stakingToken} staking token with ${cake} cake`)
        console.log(`Compounded ${compounded} LP with ${rewards} reward token`)
    })

    it("Should earned after second compound", async () => {
        const earnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)

        const earnedRewards = ethers.utils.formatUnits(
            earnedLPAmountBefore,
            18
        )
        console.log(`Earned ${earnedRewards} rewards in ${numFFBlocks} blocks`)
    })

    it("Should getReward and convert to BCNT", async () => {
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)
        const userStakeBalanceBefore = await rewardCompound.callStatic.balanceOf(userAddr)

        const totalRewardShareBefore = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await rewardCompound.callStatic.earned(rewardCompound.address)
        const lpAmountCompoundedBefore = await rewardCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]

        const tx = await rewardCompound.connect(user).getReward(minReceivedToken0Amount, minReceivedToken1Amount, minReceivedToken0Amount)
        const receipt = await tx.wait()

        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddr)
        // Should receive BCNT
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userStakeBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await rewardCompound.callStatic._share(userAddr)
        const totalRewardShareAfter = await rewardCompound.callStatic._shareTotal()
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        // Assume no one else staking: should have no rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const totalEarnedLPAmountAfter = await rewardCompound.callStatic.earned(rewardCompound.address)
        const lpAmountCompoundedAfter = await rewardCompound.callStatic.lpAmountCompounded()
        const receivedCompoundedLPAmount = lpAmountCompoundedBefore.sub(lpAmountCompoundedAfter)
        // Should receive compounded LP
        expect(receivedCompoundedLPAmount).to.equal(lpAmountCompoundedBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))

        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        // Should match the stake balance difference and received LP amount
        expect(rewardCompoundStakeBalanceAfter).to.equal(rewardCompoundStakeBalanceBefore.sub(receivedCompoundedLPAmount))
        // Assume no one else staking: RewardCompoundCakeFarm balance should be the same as user balance plus total compounded LP amount
        expect(rewardCompoundStakeBalanceAfter).to.equal(userStakeBalanceAfter.add(totalEarnedLPAmountAfter))

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Get ${receivedCompoundedLP} extra LP(reward)`)
        const receivedBCNT = ethers.utils.formatUnits(
            userBCNTBalanceAfter.sub(userBCNTBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedBCNT} BCNT`)
    })

    it("Should compound", async () => {
        // Fast forward some blocks, accrue some reward
        numFFBlocks = 1000
        await mineBlocks(numFFBlocks)

        const lpAmountCompoundedBefore = await rewardCompound.callStatic.lpAmountCompounded()
        const rewardCompoundStakeBalanceBefore = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        const rewardCompoundEarnedRewardsBefore = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)

        const tx = await rewardCompound.connect(operator).compound(
            [
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken0Amount,
                minReceivedToken1Amount
            ]
        )

        // Should match amount compounded and balance increase of RewardCompoundCakeFarm 
        const lpAmountCompoundedAfter = await rewardCompound.callStatic.lpAmountCompounded()
        const compoundedAmount = lpAmountCompoundedAfter.sub(lpAmountCompoundedBefore)
        expect(compoundedAmount).to.be.gt(0)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        expect(rewardCompoundStakeBalanceAfter.sub(rewardCompoundStakeBalanceBefore)).to.equal(compoundedAmount)
        // Should be no rewards left
        const rewardCompoundEarnedRewardsAfter = await masterChef.callStatic.pendingCake(poolId, rewardCompound.address)
        expect(rewardCompoundEarnedRewardsAfter).to.equal(0)

        const rewardsAmount = rewardCompoundEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const compounded = ethers.utils.formatUnits(
            compoundedAmount,
            18
        )
        console.log(`Compounded ${compounded} LP with ${rewards} rewards`)
    })

    it("Should exit and convert to WOOF, and convert reward to BCNT ", async () => {
        // Fast forward some blocks, accrue some reward
        numFFBlocks = 10
        await mineBlocks(numFFBlocks)

        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddr)
        const userWOOFBalanceBefore = await woof.callStatic.balanceOf(userAddr)
        const userRewardShareBefore = await rewardCompound.callStatic._share(userAddr)
        const userEarnedLPAmountBefore = await rewardCompound.callStatic.earned(userAddr)
        
        const totalRewardShareBefore = await rewardCompound.callStatic._shareTotal()
        const totalEarnedLPAmountBefore = await rewardCompound.callStatic.earned(rewardCompound.address)
        const lpAmountCompoundedBefore = await rewardCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedLPAmountBefore).to.equal(totalEarnedLPAmountBefore)
        expect(totalEarnedLPAmountBefore).to.equal(lpAmountCompoundedBefore)

        const token0Percentage = 0
        const tx = await rewardCompound.connect(user).exit(minReceivedToken0Amount, minReceivedToken1Amount, minReceivedToken0Amount, token0Percentage)
        const receipt = await tx.wait()

        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddr)
        // Should receive BCNT
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userWOOFalanceAfter = await woof.callStatic.balanceOf(userAddr)
        // Should receive reward
        expect(userWOOFalanceAfter).to.be.gt(userWOOFBalanceBefore)
        const userStakeBalanceAfter = await rewardCompound.callStatic.balanceOf(userAddr)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await rewardCompound.callStatic._share(userAddr)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await rewardCompound.callStatic._shareTotal()
        // Assume no one else staking: should be no total earned rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const lpAmountCompoundedAfter = await rewardCompound.callStatic.lpAmountCompounded()
        // Assume no one else staking: should be no compounded LP left
        expect(lpAmountCompoundedAfter).to.equal(0)
        const receivedCompoundedLPAmount = lpAmountCompoundedBefore.sub(lpAmountCompoundedAfter)
        // Should receive compounded LP tokens
        expect(receivedCompoundedLPAmount).to.be.gt(0)
        const expectedEarnedWithdrawn = userRewardShareBefore
        const expectedCompoundedLPAmountReceived = lpAmountCompoundedBefore.mul(expectedEarnedWithdrawn).div(totalRewardShareBefore)
        // Should match actual received LP amount and expected received LP Amount
        // It should not be exact match but if the amount is small enough, it wouldn't matter
        const bonusAmountDiff = (
            receivedCompoundedLPAmount.gt(expectedCompoundedLPAmountReceived) ?
            receivedCompoundedLPAmount.sub(expectedCompoundedLPAmountReceived) : expectedCompoundedLPAmountReceived.sub(receivedCompoundedLPAmount)
        )
        expect(bonusAmountDiff).to.be.lt(10**6)
        const rewardCompoundLPBalanceAfter = await mwLP.callStatic.balanceOf(rewardCompound.address)
        // Should not accrue any LP tokens in RewardCompoundCakeFarm contract
        expect(rewardCompoundLPBalanceAfter).to.equal(0)
        const rewardCompoundStakeBalanceAfter = (await masterChef.callStatic.userInfo(poolId, rewardCompound.address))[0]
        // Assume no one else staking: should be no RewardCompoundCakeFarm balance left
        expect(rewardCompoundStakeBalanceAfter).to.equal(0)

        const receivedCompoundedLP = ethers.utils.formatUnits(
            receivedCompoundedLPAmount,
            18
        )
        console.log(`Exit and get ${receivedCompoundedLP} extra LP`)
        const receivedWOOF = ethers.utils.formatUnits(
            userWOOFalanceAfter.sub(userWOOFBalanceBefore),
            18
        )
        console.log(`Converted LP to ${receivedWOOF} WOOF`)
        const receivedBCNT = ethers.utils.formatUnits(
            userBCNTBalanceAfter.sub(userBCNTBalanceBefore),
            18
        )
        console.log(`Converted extra LP(reward) to ${receivedBCNT} BCNT (includes BCNT withdraw from StakingRewards)`)
    })
})