import { expect, use } from "chai"
import { ethers, network } from "hardhat"
import { BigNumber, Contract, Signer, Wallet } from "ethers"
import { fastforward } from "./utils/network"
import * as addr from "./utils/address"
import { setERC20Balance } from "./utils/balance"
import { parseLogsByName } from "./utils/events"
import { encodePath, FeeAmount } from "./utils/uniV3"

describe("StakeCurveConvex", function () {
    // Roles
    let operator: Signer, operatorAddress: string
    let receiver: Signer, receiverAddress: string
    let owner: Signer
    let user: Signer, userAddress: string

    // Contracts
    const IERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20"
    let dai: Contract, usdc: Contract, cDAIcUSDCLP: Contract
    let cvx: Contract, crv: Contract
    let bcnt: Contract
    let curveDepositCompound: Contract
    let convexBooster: Contract
    let convexBaseRewardPool: Contract
    let uniswapV2Router: Contract
    let converterImpl: Contract
    let converter: Contract
    let stakeCurveConvexImpl: Contract
    let stakeCurveConvex: Contract

    const cDAIcUSDCLPAddr = "0x845838DF265Dcd2c412A1Dc9e959c7d08537f8a2"
    const curveDepositCompoundAddr = "0xeB21209ae4C2c9FF2a86ACA31E123764A3B6Bc06" // cDAI + cUSDC Deposit Compound
    const pid = 0 // cDAI + cUSDC BaseRewardPool ID
    const convexBoosterAddr = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31"
    const convexBaseRewardPoolAddr = "0xf34DFF761145FF0B05e917811d488B441F33a968" // cDAI + cUSDC BaseRewardPool
    const uniV2RouterAddr = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    const uniV3RouterAddr = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    const converterUniV3Addr = "0xA2A4D28a8ab49381F1eae70cd5844d9D72856Ff2"
    const stakeCurveConvexAddr = "0x18736c1c7caf0833dd459b40edaca7769a2fb3e8"

    const operatorAddr = "0xc8b6a9391E418aCe4F0C7f3D79ECA387f4022E45"

    let cvxToBCNTUniV3SwapPath = encodePath(
        [addr.CVX_ADDR, addr.WETH_ADDR, addr.BCNT_ADDR],
        [FeeAmount.HIGH, FeeAmount.HIGH]
    )
    let crvToBCNTUniV3SwapPath = encodePath(
        [addr.CRV_ADDR, addr.WETH_ADDR, addr.BCNT_ADDR],
        [FeeAmount.HIGH, FeeAmount.HIGH]
    )

    let ffSeconds
    const minReceivedToken0Amount = 0, minReceivedToken1Amount = 0, minReceivedBCNTAmount = 0, minReceivedLPAmount = 0

    before(async () => {
        [user, receiver, operator] = await ethers.getSigners()
        userAddress = await user.getAddress()
        receiverAddress = await receiver.getAddress()
        operatorAddress = await operator.getAddress()

        // await operator.sendTransaction({to: ownerAddr, value: ethers.utils.parseUnits('1')})

        // Use fork mainnet state
        dai = await ethers.getContractAt(IERC20, addr.DAI_ADDR)
        expect(await dai.totalSupply()).gt(0)
        usdc = await ethers.getContractAt(IERC20, addr.USDC_ADDR)
        expect(await usdc.totalSupply()).gt(0)
        cDAIcUSDCLP = await ethers.getContractAt(IERC20, cDAIcUSDCLPAddr)
        expect(await cDAIcUSDCLP.totalSupply()).gt(0)
        cvx = await ethers.getContractAt(IERC20, addr.CVX_ADDR)
        expect(await cvx.totalSupply()).gt(0)
        crv = await ethers.getContractAt(IERC20, addr.CRV_ADDR)
        expect(await crv.totalSupply()).gt(0)
        bcnt = await ethers.getContractAt(IERC20, addr.BCNT_ADDR)
        expect(await bcnt.totalSupply()).gt(0)
        curveDepositCompound = await ethers.getContractAt("IDepositCompound", curveDepositCompoundAddr)
        convexBooster = await ethers.getContractAt("IConvexBooster", convexBoosterAddr)
        const poolInfo = await convexBooster.callStatic.poolInfo(pid)
        expect(cDAIcUSDCLP.address).to.equal(poolInfo.lptoken)
        convexBaseRewardPool = await ethers.getContractAt("IConvexBaseRewardPool", convexBaseRewardPoolAddr)
        expect(convexBaseRewardPool.address).to.equal(poolInfo.crvRewards)
        expect(await convexBaseRewardPool.callStatic.rewardToken()).to.equal(crv.address)
        expect(await convexBaseRewardPool.callStatic.stakingToken()).to.equal(poolInfo.token)

        // Set token balance
        await setERC20Balance(dai.address, userAddress, ethers.utils.parseEther("10000000"))
        await setERC20Balance(usdc.address, userAddress, ethers.utils.parseUnits("10000000", "mwei"))

        
        // Use deployed Converter instance
        converter = await ethers.getContractAt("ConverterUniV3", converterUniV3Addr)
        // Deploy Converter
        const converterName = "Token Converter with UniV3"
        // converterImpl = await (
        //     await ethers.getContractFactory("ConverterUniV3", operator)
        // ).deploy()
        // const converterInitData = converterImpl.interface.encodeFunctionData("initialize(address,string,address,address,address)", [
        //     addr.WETH_ADDR,  // Route the swap path through native token
        //     converterName,
        //     operatorAddress,
        //     uniV2RouterAddr,
        //     uniV3RouterAddr
        // ])
        // converter = await (
        //     await ethers.getContractFactory("UpgradeProxy", operator)
        // ).deploy(
        //     converterImpl.address,
        //     converterInitData
        // )
        // // Change instance ABI from UpgradeProxy to implementation
        // converter = converterImpl.attach(converter.address)
        expect(await converter.callStatic.name()).to.equal(converterName)
        // expect(await converter.callStatic.owner()).to.equal(operatorAddress)
        expect(await converter.callStatic.router()).to.equal(uniV2RouterAddr)
        expect(await converter.callStatic.routerUniV3()).to.equal(uniV3RouterAddr)

        
        // Use deployed StakeCurveConvex instance
        // stakeCurveConvex = await ethers.getContractAt("StakeCurveConvex", stakeCurveConvexAddr)
        // await network.provider.request({
        //     method: "hardhat_impersonateAccount",
        //     params: [operatorAddr]
        // })
        // operator = ethers.provider.getSigner(operatorAddr)
        // operatorAddress = await operator.getAddress()
        // await user.sendTransaction({to: operatorAddress, value: ethers.utils.parseUnits('1')})
        // Deploy StakeCurveConvex
        const stakeCurveConvexName = "DAI/USDC StakeCurveConvex"
        stakeCurveConvexImpl = await (
            await ethers.getContractFactory("StakeCurveConvex", operator)
        ).deploy()
        const acInitData = stakeCurveConvexImpl.interface.encodeFunctionData("initialize", [
            stakeCurveConvexName,
            pid,
            operatorAddress,
            operatorAddress,
            converter.address,
            curveDepositCompound.address,
            convexBooster.address,
            convexBaseRewardPool.address,
            addr.BCNT_ADDR
        ])
        stakeCurveConvex = await (
            await ethers.getContractFactory("UpgradeProxy", operator)
        ).deploy(
            stakeCurveConvexImpl.address,
            acInitData
        )
        // Change StakeCurveConvex instance ABI from UpgradeProxy to StakeCurveConvex implementation
        stakeCurveConvex = stakeCurveConvexImpl.attach(stakeCurveConvex.address)
        expect(await stakeCurveConvex.callStatic.implementation()).to.equal(stakeCurveConvexImpl.address)
        expect(await stakeCurveConvex.callStatic.name()).to.equal(stakeCurveConvexName)
        expect(await stakeCurveConvex.callStatic.operator()).to.equal(operatorAddress)
        expect(await stakeCurveConvex.callStatic.converter()).to.equal(converter.address)
        expect(await stakeCurveConvex.callStatic.token0()).to.equal(dai.address)
        expect(await stakeCurveConvex.callStatic.token1()).to.equal(usdc.address)
        expect(await stakeCurveConvex.callStatic.crv()).to.equal(crv.address)
        expect(await stakeCurveConvex.callStatic.cvx()).to.equal(cvx.address)
        // Set UniV3 path
        expect(cvxToBCNTUniV3SwapPath).to.equal(
            encodePath(
                [addr.CVX_ADDR, addr.WETH_ADDR, addr.BCNT_ADDR],
                [FeeAmount.HIGH, FeeAmount.HIGH]
            )
        )
        await stakeCurveConvex.connect(operator).updateCVXToBCNTUniV3SwapPath(cvxToBCNTUniV3SwapPath)
        expect(await stakeCurveConvex.callStatic.cvxToBCNTUniV3SwapPath()).to.equal(cvxToBCNTUniV3SwapPath)
        expect(crvToBCNTUniV3SwapPath).to.equal(
            encodePath(
                [addr.CRV_ADDR, addr.WETH_ADDR, addr.BCNT_ADDR],
                [FeeAmount.HIGH, FeeAmount.HIGH]
            )
        )
        await stakeCurveConvex.connect(operator).updateCRVToBCNTUniV3SwapPath(crvToBCNTUniV3SwapPath)
        expect(await stakeCurveConvex.callStatic.crvToBCNTUniV3SwapPath()).to.equal(crvToBCNTUniV3SwapPath)
    })

    it("Should not re-initialize", async () => {
        const stakeCurveConvexName = "BLABLABLA"
        await expect(stakeCurveConvex.connect(user).initialize(
            stakeCurveConvexName,
            pid,
            receiverAddress,
            receiverAddress,
            converter.address,
            curveDepositCompound.address,
            convexBooster.address,
            convexBaseRewardPool.address,
            addr.BCNT_ADDR
        )).to.be.revertedWith("Already initialized")
    })

    it("Should not upgrade by non-owner", async () => {
        await expect(stakeCurveConvex.connect(receiver).upgradeTo(
            receiverAddress
        )).to.be.revertedWith("Only the contract owner may perform this action")
    })

    it("Should stake with DAI", async () => {
        // const userDAIBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        // expect(userDAIBalanceBefore).to.be.gt(0)
        // const userUSDCBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        // expect(userUSDCBalanceBefore).to.be.gt(0)

        const stakeCurveConvexLPBalanceBefore = await cDAIcUSDCLP.callStatic.balanceOf(stakeCurveConvex.address)
        expect(stakeCurveConvexLPBalanceBefore).to.equal(0)
        const stakeCurveConvexStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        const userStakeBalanceBefore = await stakeCurveConvex.callStatic.balanceOf(userAddress)

        const stakeAmount = ethers.utils.parseUnits("100000") // 100k DAI
        await dai.connect(user).approve(stakeCurveConvex.address, stakeAmount)

        const isToken0 = true
        const tx = await stakeCurveConvex.connect(user).stake(isToken0, stakeAmount, minReceivedLPAmount)
        const receipt = await tx.wait()

        const stakeCurveConvexLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(stakeCurveConvex.address)
        expect(stakeCurveConvexLPBalanceAfter).to.equal(0)
        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        const userStakeBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        const stakedAmount = stakeCurveConvexStakeBalanceAfter.sub(stakeCurveConvexStakeBalanceBefore)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)
        expect(stakedAmount).to.be.gt(0)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with USDC", async () => {
        // const userDAIBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        // expect(userDAIBalanceBefore).to.be.gt(0)
        // const userUSDCBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        // expect(userUSDCBalanceBefore).to.be.gt(0)
        const userStakeBalanceBefore = await stakeCurveConvex.callStatic.balanceOf(userAddress)

        const stakeCurveConvexLPBalanceBefore = await cDAIcUSDCLP.callStatic.balanceOf(stakeCurveConvex.address)
        expect(stakeCurveConvexLPBalanceBefore).to.equal(0)
        const stakeCurveConvexStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)

        const stakeAmount = ethers.utils.parseUnits("100000", "mwei") // 100k USDC
        await usdc.connect(user).approve(stakeCurveConvex.address, stakeAmount)

        const isToken0 = false
        const tx = await stakeCurveConvex.connect(user).stake(isToken0, stakeAmount, minReceivedLPAmount)
        const receipt = await tx.wait()

        // Should not earn anything the moment staking
        const earnedBCNTAmount = await stakeCurveConvex.callStatic.earned(userAddress)
        expect(earnedBCNTAmount).to.equal(0)
        // Should not accrue any LP tokens in StakeCurveConvex contract
        const stakeCurveConvexLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(stakeCurveConvex.address)
        expect(stakeCurveConvexLPBalanceAfter).to.equal(0)
        // Should match stake amount
        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        const stakedAmount = stakeCurveConvexStakeBalanceAfter.sub(stakeCurveConvexStakeBalanceBefore)
        expect(stakedAmount).to.be.gt(0)
        const userStakeBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        expect(userStakeBalanceAfter.sub(userStakeBalanceBefore)).to.equal(stakedAmount)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should stake with LP Token", async () => {
        const stakeCurveConvexStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)

        // Add liquidity to get LP token
        const userLPAmountBefore = await cDAIcUSDCLP.callStatic.balanceOf(userAddress)
        const daiAddAmount = ethers.utils.parseUnits("100000")
        const usdcAddAmount = ethers.utils.parseUnits("100000", "mwei")
        await dai.connect(user).approve(curveDepositCompound.address, daiAddAmount)
        await usdc.connect(user).approve(curveDepositCompound.address, usdcAddAmount)
        const tokenAmounts = [
            daiAddAmount,
            usdcAddAmount
        ]
        await curveDepositCompound.connect(user).add_liquidity(tokenAmounts, minReceivedLPAmount)
        const userLPAmountAfter = await cDAIcUSDCLP.callStatic.balanceOf(userAddress)
        const lpAmount = userLPAmountAfter.sub(userLPAmountBefore)

        // LP token amount
        const stakeAmount = lpAmount
        await cDAIcUSDCLP.connect(user).approve(stakeCurveConvex.address, stakeAmount)

        const tx = await stakeCurveConvex.connect(user).stakeWithLP(stakeAmount)
        const receipt = await tx.wait()

        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        const stakedAmount = stakeCurveConvexStakeBalanceAfter.sub(stakeCurveConvexStakeBalanceBefore)

        const staked = ethers.utils.formatUnits(
            stakedAmount,
            18
        )
        console.log(`Staked ${staked} LP`)
    })

    it("Should not earned before accrueBCNT", async () => {
        const earnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(userAddress)
        expect(earnedBCNTAmountBefore).to.equal(0)

        ffSeconds = 1000
        await fastforward(ffSeconds)

        const earnedBCNTAmountAfter = await stakeCurveConvex.callStatic.earned(userAddress)
        expect(earnedBCNTAmountAfter).to.equal(earnedBCNTAmountBefore)
    })

    it("Should accrueBCNT", async () => {
        const userBalanceBefore = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await stakeCurveConvex.callStatic._share(userAddress)
        const userEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(userAddress)

        const totalSupplyBefore = await stakeCurveConvex.callStatic.totalSupply()
        const bcntRewardAmountBefore = await stakeCurveConvex.callStatic.bcntRewardAmount()
        const totalRewardShareBefore = await stakeCurveConvex.callStatic._shareTotal()
        const totalEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(stakeCurveConvex.address)
        const stakeCurveConvexBCNTBalanceBefore = await bcnt.callStatic.balanceOf(stakeCurveConvex.address)
        const stakeCurveConvexEarnedRewardsBefore = await convexBaseRewardPool.callStatic.earned(stakeCurveConvex.address)
        // Should have accrued reward to accrueBCNT
        expect(stakeCurveConvexEarnedRewardsBefore).to.be.gt(0)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareBefore).to.equal(userRewardShareBefore)
        expect(totalRewardShareBefore).to.equal(stakeCurveConvexEarnedRewardsBefore)
        // Should not earn any LP tokens before accrueBCNT
        expect(userEarnedBCNTAmountBefore).to.equal(0)
        expect(totalEarnedBCNTAmountBefore).to.equal(0)

        const tx = await stakeCurveConvex.connect(operator).accrueBCNT(
            minReceivedToken0Amount,
            minReceivedToken0Amount
        )
        const receipt = await tx.wait()
        const events = parseLogsByName(stakeCurveConvex, "ConvertFailed", receipt.logs)
        for (const event of events) {
            console.log("ConvertFailed event")
            console.log(`fromToken: ${event.args.fromToken}`)
            console.log(`toToken: ${event.args.toToken}`)
            console.log(`fromAmount: ${event.args.fromAmount.toString()}`)
            console.log(`reason: ${event.args.reason}`)
            console.log(`lowLevelData: ${event.args.lowLevelData}`)
        }

        // Should not change User's balance and total supply
        const userBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        expect(userBalanceAfter).to.equal(userBalanceBefore)
        const totalSupplyAfter = await stakeCurveConvex.callStatic.totalSupply()
        expect(totalSupplyAfter).to.equal(totalSupplyBefore)
        // Should match new BCNT Reward amount
        const bcntRewardAmountAfter = await stakeCurveConvex.callStatic.bcntRewardAmount()
        const newBCNTRewardAmount = bcntRewardAmountAfter.sub(bcntRewardAmountBefore)
        expect(newBCNTRewardAmount).to.be.gt(0)
        const stakeCurveConvexBCNTBalanceAfter = await bcnt.callStatic.balanceOf(stakeCurveConvex.address)
        expect(stakeCurveConvexBCNTBalanceAfter.sub(stakeCurveConvexBCNTBalanceBefore)).to.equal(newBCNTRewardAmount)
        // Should be no rewards left
        const stakeCurveConvexEarnedRewardsAfter = await convexBaseRewardPool.callStatic.earned(stakeCurveConvex.address)
        expect(stakeCurveConvexEarnedRewardsAfter).to.equal(0)
        const userRewardShareAfter = await stakeCurveConvex.callStatic._share(userAddress)
        const totalRewardShareAfter = await stakeCurveConvex.callStatic._shareTotal()
        const totalEarnedBCNTAmountAfter = await stakeCurveConvex.callStatic.earned(stakeCurveConvex.address)
        // Assume no one else staking: user reward should be the same as total rewards
        expect(totalRewardShareAfter).to.equal(userRewardShareAfter)
        // Should match new BCNT Reward amount
        expect(totalEarnedBCNTAmountAfter).to.equal(newBCNTRewardAmount)
        
        const rewardsAmount = stakeCurveConvexEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const newBCNTReward = ethers.utils.formatUnits(
            newBCNTRewardAmount,
            18
        )
        console.log(`Accured ${newBCNTReward} BCNT with ${rewards} rewards`)
    })

    it("Should earned after accrueBCNT", async () => {
        const earnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(userAddress)

        const earnedRewards = ethers.utils.formatUnits(
            earnedBCNTAmountBefore,
            18
        )
        console.log(`Earned ${earnedRewards} rewards in ${ffSeconds} seconds`)
    })

    it("Should withdraw and convert to DAI", async () => {
        const userDAIBalanceBefore = await dai.callStatic.balanceOf(userAddress)
        const userStakeBalanceBefore = await stakeCurveConvex.callStatic.balanceOf(userAddress)

        const stakeCurveConvexStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)

        const withdrawAmount = ethers.utils.parseUnits("5")

        const toToken0 = true
        const tx = await stakeCurveConvex.connect(user).withdraw(toToken0, minReceivedToken0Amount, withdrawAmount)
        const receipt = await tx.wait()

        const userDAIBalanceAfter = await dai.callStatic.balanceOf(userAddress)
        // Should receive withdrawal
        expect(userDAIBalanceAfter).to.be.gt(userDAIBalanceBefore)
        const userStakeBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        // Should match balance difference and withdraw amount
        expect(userStakeBalanceBefore.sub(userStakeBalanceAfter)).to.equal(withdrawAmount)

        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        // Should match StakeCurveConvex balance difference and user withdraw amount
        expect(stakeCurveConvexStakeBalanceBefore.sub(stakeCurveConvexStakeBalanceAfter)).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawAmount,
            18
        )

        console.log(`Withdrew ${withdrew} LP`)
        const receivedDAI = ethers.utils.formatUnits(
            userDAIBalanceAfter.sub(userDAIBalanceBefore),
            18
        )
        console.log(`Converted to ${receivedDAI} DAI`)
    })

    it("Should withdraw with LP Token", async () => {
        const stakeCurveConvexStakeBalanceBefore = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)

        // LP token amount
        const withdrawAmount = ethers.utils.parseUnits('1')

        const tx = await stakeCurveConvex.connect(user).withdrawWithLP(withdrawAmount)
        const receipt = await tx.wait()

        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        const withdrawnAmount = stakeCurveConvexStakeBalanceBefore.sub(stakeCurveConvexStakeBalanceAfter)
        expect(withdrawnAmount).to.equal(withdrawAmount)

        const withdrew = ethers.utils.formatUnits(
            withdrawnAmount,
            18
        )
        console.log(`Withdrew ${withdrew} LP`)
    })

    it("Should getReward and receive BCNT", async () => {
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await stakeCurveConvex.callStatic._share(userAddress)
        const userEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(userAddress)
        const userStakeBalanceBefore = await stakeCurveConvex.callStatic.balanceOf(userAddress)

        const totalRewardShareBefore = await stakeCurveConvex.callStatic._shareTotal()
        const totalEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(stakeCurveConvex.address)
        const bcntRewardAmountBefore = await stakeCurveConvex.callStatic.bcntRewardAmount()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBCNTAmountBefore).to.equal(totalEarnedBCNTAmountBefore)
        expect(totalEarnedBCNTAmountBefore).to.equal(bcntRewardAmountBefore)

        const tx = await stakeCurveConvex.connect(user).getReward()
        const receipt = await tx.wait()

        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        // Should receive reward
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userStakeBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        // Should not change user stake balance
        expect(userStakeBalanceAfter).to.equal(userStakeBalanceBefore)

        const userRewardShareAfter = await stakeCurveConvex.callStatic._share(userAddress)
        const totalRewardShareAfter = await stakeCurveConvex.callStatic._shareTotal()
        // Should have no rewards left
        expect(userRewardShareAfter).to.equal(0)
        // Assume no one else staking: should have no rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const bcntRewardAmountAfter = await stakeCurveConvex.callStatic.bcntRewardAmount()
        const receivedBCNTRewardAmount = bcntRewardAmountBefore.sub(bcntRewardAmountAfter)
        // Should receive BCNT Reward proportional to user's share
        expect(receivedBCNTRewardAmount).to.equal(bcntRewardAmountBefore.mul(userRewardShareBefore).div(totalRewardShareBefore))

        const receivedBCNTReward = ethers.utils.formatUnits(
            receivedBCNTRewardAmount,
            18
        )
        console.log(`Get ${receivedBCNTReward} BCNT reward`)
    })

    it("Should accrueBCNT", async () => {
        // Fast forward sometime, accrue some reward
        ffSeconds = 1000
        await fastforward(ffSeconds)

        const bcntRewardAmountBefore = await stakeCurveConvex.callStatic.bcntRewardAmount()
        const stakeCurveConvexEarnedRewardsBefore = await convexBaseRewardPool.callStatic.earned(stakeCurveConvex.address)

        const tx = await stakeCurveConvex.connect(operator).accrueBCNT(
            minReceivedToken0Amount,
            minReceivedToken0Amount
        )
        const receipt = await tx.wait()
        const events = parseLogsByName(stakeCurveConvex, "ConvertFailed", receipt.logs)
        for (const event of events) {
            console.log("ConvertFailed event")
            console.log(`fromToken: ${event.args.fromToken}`)
            console.log(`toToken: ${event.args.toToken}`)
            console.log(`fromAmount: ${event.args.fromAmount.toString()}`)
            console.log(`reason: ${event.args.reason}`)
            console.log(`lowLevelData: ${event.args.lowLevelData}`)
        }

        // Should match amount newBCNTReward and balance increase of StakeCurveConvex 
        const bcntRewardAmountAfter = await stakeCurveConvex.callStatic.bcntRewardAmount()
        const newBCNTRewardAmount = bcntRewardAmountAfter.sub(bcntRewardAmountBefore)
        expect(newBCNTRewardAmount).to.be.gt(0)
        
        const rewardsAmount = stakeCurveConvexEarnedRewardsBefore
        const rewards = ethers.utils.formatUnits(
            rewardsAmount,
            18
        )
        const newBCNTReward = ethers.utils.formatUnits(
            newBCNTRewardAmount,
            18
        )
        console.log(`Accured ${newBCNTReward} BCNT with ${rewards} rewards`)
    })

    it("Should exit and convert to USDC and also receive BCNT", async () => {
        const userUSDCBalanceBefore = await usdc.callStatic.balanceOf(userAddress)
        const userBCNTBalanceBefore = await bcnt.callStatic.balanceOf(userAddress)
        const userRewardShareBefore = await stakeCurveConvex.callStatic._share(userAddress)
        const userEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(userAddress)
        console.log("user balance before: ", (await stakeCurveConvex.callStatic.balanceOf(userAddress)).toString())

        const totalRewardShareBefore = await stakeCurveConvex.callStatic._shareTotal()
        const totalEarnedBCNTAmountBefore = await stakeCurveConvex.callStatic.earned(stakeCurveConvex.address)
        const bcntRewardAmountBefore = await stakeCurveConvex.callStatic.bcntRewardAmount()
        // Assume no one else staking: user reward should be the same as total rewards
        expect(userEarnedBCNTAmountBefore).to.equal(totalEarnedBCNTAmountBefore)
        expect(totalEarnedBCNTAmountBefore).to.equal(bcntRewardAmountBefore)

        const toToken0 = false
        const tx = await stakeCurveConvex.connect(user).exit(toToken0, minReceivedToken0Amount)
        // const tx = await stakeCurveConvex.connect(user).exitWithLP()
        const receipt = await tx.wait()

        const userUSDCalanceAfter = await usdc.callStatic.balanceOf(userAddress)
        const userBCNTBalanceAfter = await bcnt.callStatic.balanceOf(userAddress)
        // Should receive withdrawal
        expect(userUSDCalanceAfter).to.be.gt(userUSDCBalanceBefore)
        // Should receive reward
        expect(userBCNTBalanceAfter).to.be.gt(userBCNTBalanceBefore)
        const userStakeBalanceAfter = await stakeCurveConvex.callStatic.balanceOf(userAddress)
        // Should be no user balance left
        expect(userStakeBalanceAfter).to.equal(0)

        const userRewardShareAfter = await stakeCurveConvex.callStatic._share(userAddress)
        // Should be no user earned rewards left
        expect(userRewardShareAfter).to.equal(0)
        const totalRewardShareAfter = await stakeCurveConvex.callStatic._shareTotal()
        // Assume no one else staking: should be no total earned rewards left
        expect(totalRewardShareAfter).to.equal(0)
        const bcntRewardAmountAfter = await stakeCurveConvex.callStatic.bcntRewardAmount()
        // Assume no one else staking: should be no BCNT reward left
        expect(bcntRewardAmountAfter).to.equal(0)
        const receivedBCNTRewardAmount = bcntRewardAmountBefore.sub(bcntRewardAmountAfter)
        // Should receive BCNT reward
        expect(receivedBCNTRewardAmount).to.be.gt(0)
        const expectedEarnedWithdrawn = userRewardShareBefore
        const expectedBCNTRewardAmountReceived = bcntRewardAmountBefore.mul(expectedEarnedWithdrawn).div(totalRewardShareBefore)
        // Should match actual received BCNT amount and expected received BCNT Amount
        // It should not be exact match but if the amount is small enough, it wouldn't matter
        const bonusAmountDiff = (
            receivedBCNTRewardAmount.gt(expectedBCNTRewardAmountReceived) ?
            receivedBCNTRewardAmount.sub(expectedBCNTRewardAmountReceived) : expectedBCNTRewardAmountReceived.sub(receivedBCNTRewardAmount)
        )
        expect(bonusAmountDiff).to.be.lt(10**6)
        const stakeCurveConvexLPBalanceAfter = await cDAIcUSDCLP.callStatic.balanceOf(stakeCurveConvex.address)
        // Should not accrue any LP tokens in StakeCurveConvex contract
        expect(stakeCurveConvexLPBalanceAfter).to.equal(0)
        const stakeCurveConvexStakeBalanceAfter = await convexBaseRewardPool.callStatic.balanceOf(stakeCurveConvex.address)
        // Assume no one else staking: should be no StakeCurveConvex balance left
        expect(stakeCurveConvexStakeBalanceAfter).to.equal(0)

        const receivedBCNTReward = ethers.utils.formatUnits(
            receivedBCNTRewardAmount,
            18
        )
        console.log(`Exit and get ${receivedBCNTReward} BCNT`)
        const receivedUSDC = ethers.utils.formatUnits(
            userUSDCalanceAfter.sub(userUSDCBalanceBefore),
            6
        )
        console.log(`LP converted to ${receivedUSDC} USDC`)
    })
})