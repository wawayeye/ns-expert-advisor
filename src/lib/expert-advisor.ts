import { Log, Util } from 'ns-common';
import { GoogleFinance, DataProvider } from 'ns-findata';
import { Signal, IKdjOutput } from 'ns-signal';
import * as types from 'ns-types';
import { SignalManager, AccountManager, TraderManager, PositionManager } from 'ns-manager';

import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment';
import * as fetch from 'isomorphic-fetch';
const Loki = require('lokijs');
const config = require('config');

export interface ITradingInput {
  symbol: string,
  type: string,
  price: number,
  time: string,
  signal: {
    [Attr: string]: any
  }
}

export class ExpertAdvisor {
  symbols: string[];
  coins: string[];
  accountId: string;
  coinId: string;
  order: { [Attr: string]: any };
  backtest: {
    test: boolean,
    isLastDate: string,
    date: string,
    interval: number,
    loki: any
  };
  signal: Signal;
  // 实时监测间隔
  interval: number;
  worker: number;
  dataProvider: DataProvider;

  constructor() {
    assert(config, 'config required.');
    assert(config.trader, 'config.trader required.');
    assert(config.account, 'config.account required.');
    assert(config.ea, 'config.ea required.');
    assert(config.backtest, 'config.backtest required.');
    assert(config.store, 'config.store required.');
    this.symbols = config.ea.symbols;
    this.coins = config.ea.coins;
    this.backtest = config.backtest;
    this.interval = config.ea.interval;
    this.accountId = config.account.userId;
    this.coinId = config.account.coinId;
    this.signal = new Signal(config);
    this.dataProvider = new DataProvider(config.store);
    this.order = {
      eventType: types.EventType.Order,
      tradeType: types.TradeType.Margin,
      orderType: types.OrderType.Limit,
      side: types.OrderSide.Buy,
      amount: 100
    }
  }

  async destroy() {
    clearInterval(this.worker);
    await this.dataProvider.close();
  }

  async start() {
    await this.dataProvider.init();
    // await this.onPretrade();
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
  }

  async onPretrade() {
    Log.system.info('预交易分析[启动]');
    let signalList: IKdjOutput[] = [];
    let watchList: string[] = []
    if (this.coins && this.coins.length > 0) {
      signalList = signalList.concat(<IKdjOutput[]>await this.signal.kdj(
        this.coins, types.SymbolType.cryptocoin, types.CandlestickUnit.Min5));
      watchList = this.coins;
    }
    if (Util.isTradeTime() && this.symbols.length > 0) {
      watchList = watchList.concat(this.symbols)
      Log.system.info('股市交易时间,查询股市信号');
      signalList = signalList.concat(<IKdjOutput[]>await this.signal.kdj(
        this.symbols, types.SymbolType.stock, types.CandlestickUnit.Min5));
    }
    Log.system.info('监视列表：', watchList);
    let i = 0;
    for (const symbol of watchList) {
      Log.system.info(`处理商品：${symbol}`);
      // 查询数据库中的信号
      const dbSignal = await SignalManager.get({ symbol });
      Log.system.info(`查询数据库中的信号:${JSON.stringify(dbSignal)}`);
      try {
        const signal = signalList[i];
        // kdj算出信号时
        if (signal && signal.side) {
          await this.signalHandle(symbol, signal);
        }
        // 数据库中已存储信号
        if (dbSignal) {
          // 交易处理
          await this.tradingHandle({
            symbol,
            type: <types.SymbolType>signal.symbolType,
            price: <number>signal.lastPrice,
            time: <string>signal.lastTime,
            signal: dbSignal
          });
        }
        i++;
      } catch (err) {
        Log.system.error(err.stack);
      }
    }

    Log.system.info('预交易分析[终了]');
  }

  // 信号处理
  async signalHandle(symbol: string, signal: IKdjOutput) {
    const modelSignal: types.Model.Signal = Object.assign({
      symbol,
      price: signal.lastPrice,
      notes: `k值：${signal.k}`
    }, signal, { side: String(signal.side) });

    if (this.backtest.test) {
      modelSignal.backtest = '1';
      // modelSignal.mocktime = signal.lastTime;
    }

    // 删除已存在信号
    const dbSignal = await SignalManager.get(modelSignal);
    if (dbSignal) {
      await SignalManager.remove(String(dbSignal.id));
    }
    // 记录信号
    await SignalManager.set(modelSignal);
    // 推送信号警报
    await this.alertHandle(modelSignal);
  }

  // 交易处理
  async tradingHandle(input: ITradingInput) {
    Log.system.info('交易信号处理[启动]');
    let accountId = this.accountId;
    if (input.type === types.SymbolType.cryptocoin) {
      accountId = this.coinId;
    }
    // 查询资产
    const account = await AccountManager.get(accountId);
    if (!account) {
      Log.system.error(`系统出错，未查询到用户(${accountId})信息。`);
      return;
    }
    // 订单对象
    const order = <types.LimitOrder>Object.assign({}, this.order, {
      symbol: input.symbol,
      price: input.price,
    });
    let tradeType;
    if (input.type === types.SymbolType.cryptocoin) {
      const res = Util.getTradeUnit(input.symbol);
      order.amount = res.amount;
      tradeType = res.type;
    }
    if (this.backtest.test) {
      order.backtest = '1';
      order.mocktime = input.time;
    }

    // 买入信号
    if (input.signal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (<number>input.signal.price < input.price) {
        Log.system.info(`买入信号出现后,${input.symbol}股价止跌上涨,买入处理[开始]`);
        order.side = input.signal.side;
        // 查询持仓
        if (account.positions && account.positions.length > 0) {
          const position = account.positions.find(posi =>
            posi.symbol === input.symbol && posi.side === input.signal.side);
          if (position) {
            Log.system.info(`查询出已持有此商品(${JSON.stringify(position, null, 2)})`);
            const buyInterval = Date.now() - new Date(String(position.created_at)).getTime();
            Log.system.info(`与持仓买卖间隔(${buyInterval})`);
            if (buyInterval <= (600 * 1000)) {
              Log.system.info(`买卖间隔小于10分钟,中断买入操作`);
              return;
            }
          }
        }

        // 订单价格
        let balance = Number(account.balance);
        const orderPrice = order.price * order.amount + Util.getFee(input.symbol);
        if (tradeType === 'btc') {
          Log.system.info('通过比特币购买');
          balance = Number(account.bitcoin);
        }
        if (balance < orderPrice) {
          Log.system.warn(`可用余额：${balance} < 订单价格：${orderPrice}，退出买入处理！`);
          return;
        }
        Log.system.info(`订单价格:${orderPrice}`);
        try {
          // 买入
          await this.postOrder(order);
          await this.postTradeSlack(order, 0);
          Log.system.info(`发送买入指令`);
        } catch (e) {
          Log.system.warn('发送买入指令失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(accountId, order);
        // 消除信号
        await SignalManager.remove(input.signal.id);
        Log.system.info(`买入处理[终了]`);
      } else if (<number>input.signal.price > input.price) { // 股价继续下跌
        Log.system.info('更新买入信号股价', input.price);
        input.signal.price = input.price;
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    } else if (input.signal.side === types.OrderSide.Sell) {
      Log.system.info('卖出信号');
      // 查询是否有持仓
      let position: types.Model.Position | undefined;
      if (account.positions) {
        position = account.positions.find((posi: types.Model.Position) => {
          return posi.symbol === String(input.symbol) && posi.side === types.OrderSide.Buy;
        })
      }
      if (!position) {
        Log.system.warn('未查询到持仓，不进行卖出！');
        return;
      }
      Log.system.info(`获取持仓:${JSON.stringify(position)}`);
      if (!position.price) {
        Log.system.error('持仓股价为空！');
        return;
      }
      Log.system.info(`信号股价(${input.signal.price}) > 当前股价(${input.price}) && 盈利超过700(${input.price - position.price} > 7)`);
      const profitRule = input.type === types.SymbolType.cryptocoin ?
        input.price > position.price : input.price - position.price > 7; // >= 1.1
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过700（数字货币无此限制）
      if (input.signal.price > input.price && profitRule) {
        Log.system.info(`卖出信号出现后,${input.symbol}股价下跌,卖出处理[开始]`);
        try {
          // 卖出
          await this.postOrder(order);
          const profit = (order.price * order.amount) - (input.price * order.amount)
            - Util.getFee(input.symbol);
          Log.system.info(`卖出利润：${profit}`);
          await this.postTradeSlack(order, profit);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(accountId, order);
        // 消除信号
        await SignalManager.remove(input.signal.id);
      } else if (input.signal.price < input.price) { // 股价继续上涨
        Log.system.info('更新卖出信号股价', input.price);
        input.signal.price = input.price;
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    }
    Log.system.info('交易信号处理[终了]');
  }

  // 警报处理
  async alertHandle(signal: types.Model.Signal) {
    await this.postSlack(signal);
  }

  async postOrder(order: types.Order): Promise<any> {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        orderInfo: order
      })
    };
    const url = `http://${config.trader.host}:${config.trader.port}/api/v1/order`;
    return await fetch(url, requestOptions);
  }

  async postSlack(signal: types.Model.Signal) {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        channel: signal.symbol.includes('_') ? '#coin' : '#kdj',
        attachments: [
          {
            color: signal.side === 'buy' ? 'danger' : 'good',
            title: '商品：' + signal.symbol,
            text: signal.notes,
            fields: [
              {
                title: '价格',
                value: signal.price + '',
                short: true
              },
              {
                title: '方向',
                value: signal.side === 'buy' ? '买入' : '卖出',
                short: true
              }
            ],
            footer: '5分钟KDJ   ' + moment().format('YYYY-MM-DD hh:mm:ss'),
            footer_icon: !signal.symbol.includes('_') ?
              'https://platform.slack-edge.com/img/default_application_icon.png' : 'https://png.icons8.com/dusk/2x/bitcoin.png'
          }
        ]
      })
    };
    return await fetch(config.slack.url, requestOptions);
  }

  async postTradeSlack(order: types.Order, profit: number) {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        channel: '#coin_trade',
        attachments: [
          {
            color: order.side === 'buy' ? 'danger' : 'good',
            title: '商品：' + order.symbol,
            fields: [
              {
                title: '价格',
                value: order.price + '',
                short: true
              },
              {
                title: '方向',
                value: order.side === 'buy' ? '买入' : '卖出',
                short: true
              },
              {
                title: '数量',
                value: order.amount + '',
                short: true
              },
              {
                title: '盈利',
                value: profit + '',
                short: true
              }
            ],
            footer: 'AI自动交易   ' + moment().format('YYYY-MM-DD hh:mm:ss'),
            footer_icon: 'https://png.icons8.com/dusk/2x/event-accepted.png'
          }
        ]
      })
    };
    return await fetch(config.slack.url, requestOptions);
  }
}
