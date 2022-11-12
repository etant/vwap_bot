import axios from 'axios';
import { ethers, utils, BigNumber } from "ethers";
import ccxt from 'ccxt';
import { createClient } from 'urql'
import 'isomorphic-unfetch';
import * as fs from 'fs';
import { AlphaRouter } from '@uniswap/smart-order-router'
import { CurrencyAmount, Token, TradeType, Percent } from '@uniswap/sdk-core'
import JSBI from 'jsbi';
import { } from 'dotenv/config'
import promptSync from 'prompt-sync'

//list of tokens and its attributes 
let token_json = './helper/token.json';
let tokens = JSON.parse(fs.readFileSync(token_json, 'utf-8'));

//ERC20 ABI
let abiJson = './helper/abi.json';
let ERC20ABI = JSON.parse(fs.readFileSync(abiJson, 'utf-8'));

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC);

//init wallet 
const WALLET_ADDRESS = process.env.WALLET_ADDRESS
const WALLET_SECRET = process.env.WALLET_SECRET
const wallet = new ethers.Wallet(WALLET_SECRET)
const connectedWallet = wallet.connect(provider)

const etherscan_api_key = "45KQ37MIS5R5WA7TQZPJ1119DHWDN8IU4P"

//init router 
const swapRouterAddress = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'
const router = new AlphaRouter({ chainId: 1, provider: provider })

//helper function to find out how many times to query cex volume data, since ccxt limits up to only 1000 datapoints per call
function loopConfig(day, num_bins) {
    let loop = 1;
    while ((day * num_bins > 1000) && Number.isInteger(day)) {
        loop += 2;
        day = day / loop
    }
    return { 'day_division': day, 'loops': loop }
}

async function cexVol(day, min, min_string, token) {
    //list of ccxt exchange ids
    const exchangeList = ['binance', 'bitfinex', 'cryptocom', 'bybit', 'gate', 'huobi', 'idex', 'mexc', 'okx']
    //three major stable coin pairs
    const pairs = [token.toUpperCase() + '/USDT', token.toUpperCase() + '/USDC', token.toUpperCase() + '/BUSD']
    //number of vwap interval per day or the numebr of "bins"
    const num_bins = 24 * 60 / min
    let loop_config = loopConfig(day, num_bins)

    //go through every exchange and every related pairs
    let historical_volume = []
    for (let id of exchangeList) {
        for (let pair of pairs) {
            let since = Date.now()
            const exchange = new ccxt[id]()
            try {
                if (exchange.has.fetchOHLCV) {
                    for (let i = 0; i < loop_config.loops; i++) {
                        //look back period 86400 sec in a day
                        since = since - loop_config.day_division * 86400 * 1000
                        //fetchOHLCV is from acsending order, so only want up to specified timestamp
                        let ohlcv = await exchange.fetchOHLCV(pair, min_string, since, 1000).then(res => res.splice(0, (num_bins * loop_config.day_division)))
                        //set rate limit to not get flagged
                        new Promise(resolve => setTimeout(resolve, exchange.rateLimit));
                        historical_volume.push(ohlcv)
                        console.log(`fetching ${id} ${pair} loop ${i + 1}`);
                    }
                }

            } catch (error) {
                console.log(error.message);
            }
        }
    }
    let sum_bin = []
    let cumsum_vol = 0
    // lowest_ts and highest_ts is used to match timestamp when querying from univ3
    let lowest_ts = historical_volume[0][0][0]
    let highest_ts = historical_volume[0][0][0]
    //divide up all the time series data to their own bin
    for (let ohlcv of historical_volume) {
        for (let i in ohlcv) {
            cumsum_vol += ohlcv[i][5]
            if (sum_bin.length < num_bins) {
                sum_bin[i % num_bins] = ohlcv[i][5]
            }
            if (lowest_ts > ohlcv[i][0]) {
                lowest_ts = ohlcv[i][0]
            }
            if (highest_ts < ohlcv[i][0]) {
                highest_ts = ohlcv[i][0]
            }
            // test to see if bins are lined up correctly
            // if (i % num_bins == 0) {
            //     console.log(new Date(ohlcv[i][0]));
            // }
            sum_bin[i % num_bins] += ohlcv[i][5]
        }
    }
    return { 'lowest_ts': lowest_ts, 'highest_ts': highest_ts, 'cumsum_vol': cumsum_vol, 'sum_bin': sum_bin }
}

async function queryV3Vol(block, pool, token) {
    try {
        //query cumlative volume from the according pool and block
        const APIURL = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3'
        const query =
            ` query {
                      pool(id: "${pool}",block: {number: ${block}})
                      {
                        volumeToken0
                        volumeToken1
                        token1 {
                          id
                        }
                        token0 {
                          id
                        }
                        }
                      }
               `
        const client = createClient({
            url: APIURL,
        })
        const result = await client.query(query).toPromise()
        //get the token volume not the stable coin volume
        if (tokens[token]["address"]['ethereum'] == result.data.pool.token1.id) {
            return result.data.pool.volumeToken1
        } else {
            return result.data.pool.volumeToken0
        }

    } catch (error) {
        return 0
    }
}
async function getV3Vol(lowest_ts, highest_ts, interval_sec, pool, token) {

    //get the corresponding block to the first and the last data point
    let url = `https://api.etherscan.io/api?module=block&action=getblocknobytime&timestamp=${lowest_ts / 1000}&closest=before&apikey=${etherscan_api_key}`
    let first_block = await axios({ method: 'get', url: url }).then(res => res["data"].result).then(res => Number(res))
    url = `https://api.etherscan.io/api?module=block&action=getblocknobytime&timestamp=${(highest_ts / 1000) + interval_sec}&closest=before&apikey=${etherscan_api_key}`
    let last_block = await axios({ method: 'get', url: url }).then(res => res["data"].result).then(res => Number(res))

    let volume_array = []
    let block = first_block
    //it is divided by 12 because average block on eth is 12 seconds since the merge
    let prev = await queryV3Vol(block - interval_sec / 12, pool, token)
    let count = (((highest_ts - lowest_ts) / interval_sec) / 1000) - 1
    for (let i = 0; i < count; i++) {
        if (block > last_block) {
            break
        }
        let result = await queryV3Vol(block, pool, token)
        block = block + interval_sec / 12
        //since the query is cumlative, subtract prev cumlative data to get data for the corrseponding time
        volume_array.push(result - prev)
        prev = result
        console.log(`univ3 historical vol query progress: ${(((i + 1) / count) * 100).toFixed(4)}%`);
    }

    //divide all the data to its corresponding bin
    let sum_bin = []
    let cumsum_vol = 0
    let num_bins = 24 * 60 * 60 / interval_sec
    for (let i in volume_array) {
        cumsum_vol += volume_array[i]
        if (sum_bin.length < num_bins) {
            sum_bin[i % num_bins] = volume_array[i]
        }
        sum_bin[i % num_bins] += volume_array[i]
    }
    return { 'sum_bin': sum_bin, 'cumsum_vol': cumsum_vol }
}

//get swapped token amount
async function tx_return_token_amt(tx, tokenName) {
    let logs = await provider.getTransactionReceipt(tx).then(res => res.logs);
    return parseFloat(ethers.utils.formatUnits(BigNumber.from(logs[0]['data']), tokens[tokenName]["min_units"]['ethereum']))
}

//get total fee used
async function tx_to_gas_cost(tx) {
    var data = await provider.getTransactionReceipt(tx);
    var gasPrice = data["effectiveGasPrice"];
    let gasUsed = data["gasUsed"];
    let gasFee = gasPrice.mul(gasUsed);
    let fee_eth = utils.formatUnits(gasFee, 18)
    return fee_eth;
}

async function trade(percent_bin, stable_coin, token, vwap_amount) {

    //time interval between each vwap
    let min_in_between = 24 * 60 / percent_bin.length

    const token0 = new Token(1, tokens[stable_coin]["address"]['ethereum'], tokens[stable_coin]["min_units"]['ethereum'], stable_coin, stable_coin)
    const token1 = new Token(1, tokens[token]["address"]['ethereum'], tokens[token]["min_units"]['ethereum'], token, token)

    //infinite approval
    const approval_amount = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const contract0 = new ethers.Contract(token0.address, ERC20ABI, provider)
    // approve stable coin to router
    try {
        let approval_hash = await contract0.connect(connectedWallet).approve(
            swapRouterAddress,
            approval_amount,
        ).then(res => res.hash)
        await provider.waitForTransaction(approval_hash)
        console.log(`inifinite token approval for ${token0.symbol}`);

    } catch (error) {
        console.log(`${token0.symbol} already approved`);
    }

    let sum_swapped = 0
    let gas_fee = 0
    for (let i = 0; i < percent_bin.length; i++) {
        let trade_amount = percent_bin[i] * vwap_amount
        const amount_adj = utils.parseUnits(trade_amount.toFixed(6), token0.decimals)
        const input_amount = CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(amount_adj))
        //query path for the swap from router
        const route = await router.route(
            input_amount,
            token1,
            TradeType.EXACT_INPUT,
            {
                recipient: WALLET_ADDRESS,
                slippageTolerance: new Percent(1, 100),
                deadline: Math.floor(Date.now() / 1000 + 1800)
            }
        )
        //build transaction
        const transaction = {
            data: route.methodParameters.calldata,
            to: swapRouterAddress,
            value: BigNumber.from(route.methodParameters.value),
            from: WALLET_ADDRESS,
            gasPrice: BigNumber.from(route.gasPriceWei),
            gasLimit: ethers.utils.hexlify(1000000)
        }

        const tx_hash = await connectedWallet.sendTransaction(transaction).then(res => res.hash)
        await provider.waitForTransaction(tx_hash)

        let swapped_amount = await tx_return_token_amt(tx_hash, token1.symbol)
        gas_fee += await tx_to_gas_cost(tx_hash)

        sum_swapped += swapped_amount
        console.log(`${trade_amount} ${token0.symbol} -> ${swapped_amount} ${token1.symbol} | ${tx_hash} | total gas fee :${gas_fee}`);
        await new Promise(r => setTimeout(r, 1000 * min_in_between * 60));
    }
    console.log(`finished vwap | average price of ${token_balance / sum_swapped} | total gas fee of ${gas_fee} eth`);

}

const main = async () => {

    const prompt = promptSync();

    let min_map = {
        '10m': 10,
        '30m': 30,
        '15m': 15,
        '1h': 60
    }
    let min, day, token, stable_coin, pool, amount
    do {
        min =  prompt('choose vwap interval 30m,10m,15m,1h (default 15m): ', '15m');
    } while (!['30m', '10m', '15m', '1h'].includes(min))

    do {
        day =  prompt('choose lookback periods 1,7,15,30,60,90 days (default 7): ', 7);
        day = parseInt(day)
    } while (![1, 7, 15, 30, 60, 90].includes(day))

    do {
        token =  prompt('token to vwap (default eth): ', 'eth');
        token = token.toLowerCase()
    } while (!(token in tokens))

    do {
        stable_coin =  prompt('choose stablecoin usdt or usdc (default usdt): ', 'usdt');
    } while (!['usdt', 'usdc'].includes(stable_coin))

    let ABI = ["function balanceOf(address account) external view returns (uint256)"];
    let token_address = tokens[stable_coin]["address"]['ethereum'];
    let contract = new ethers.Contract(token_address, ABI, provider);
    const token_balance = await contract.balanceOf(WALLET_ADDRESS).then(res => ethers.utils.formatUnits(res, tokens[stable_coin]["min_units"]['ethereum']))
    
    do {
        amount =  prompt('amount of stablecoin to vwap (default whole balance amount): ', token_balance);
        amount = parseInt(amount)
    } while (amount > token_balance)

    pool =  prompt('choose univ3 pool or none (default 0x4e68ccd3e89f51c3074ca5072bbac773960dfa36): ', '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36');

    let percent_bin
    let cex = await cexVol(day, min_map[min], min, token)
    if (pool == 'none') {
        percent_bin = cex.sum_bin.map(currentValue => currentValue / cex.cumsum_vol);
    } else {
        let dex = await getV3Vol(cex.lowest_ts, cex.highest_ts, min_map[min] * 60, pool, token)
        let sum_vol_bin = cex.sum_bin.map((num, idx) => num + dex.sum_bin[idx])
        let total_vol = cex.cumsum_vol + dex.cumsum_vol
        percent_bin = sum_vol_bin.map(currentValue => currentValue / total_vol);
    }



    // console.log(new Date(cex.highest_ts),new Date(cex.lowest_ts));


    trade(percent_bin, stable_coin, token, amount)

}
main()