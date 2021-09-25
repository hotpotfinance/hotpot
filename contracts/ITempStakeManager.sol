pragma solidity >=0.5.0 <0.9.0;

interface ITempStakeManager {
    function getStakersUpto(uint256 index) external view returns (address[] memory);
    function stake(address staker, uint256 lpAmount) external;
    function exit(address staker) external returns (uint256 lpAmount, uint256 convertedLPAmount);
    function abort(address staker) external;
}