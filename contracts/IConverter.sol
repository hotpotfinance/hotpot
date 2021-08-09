pragma solidity >=0.5.0 <0.9.0;

interface IConverter {
    function lp() external returns(address);
    function token0() external returns(address);
    function token1() external returns(address);
    function convert(address _inTokenAddress, uint256 _amount, uint256 _convertPercentage, uint256 _minReceiveAmount, address _recipient) external;
    function convertAndAddLiquidity(address _inTokenAddress, uint256 _amount, uint256 _minReceiveAmount, address _recipient) external;
    function removeLiquidityAndConvert(uint256 _lpAmount, uint256 _token0Percentage, address _recipient) external;
}