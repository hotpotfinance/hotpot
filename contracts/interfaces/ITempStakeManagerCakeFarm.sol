pragma solidity >=0.5.0 <0.9.0;
import "../interfaces/ITempStakeManager.sol";

interface ITempStakeManagerCakeFarm is ITempStakeManager {
    function abort(address staker, uint256 minBCNTAmountConverted) external;
}