import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl, SuiClient, SuiTransactionBlockResponse, SuiObjectData } from '@mysten/sui.js/client';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui.js/faucet';
import { BCS, getSuiMoveConfig, bcs } from '@mysten/bcs';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { execSync } from 'child_process';
import path from 'path';
import { MessageEncoder, MessageType } from './message_encoder';
require('dotenv').config();

const admin = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.KEY_PAIR_SEED!, 'hex')));
const user = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.USER_KEY_PAIR_SEED!, 'hex')));
const client = new SuiClient({
  url: process.env.SUI_RPC_URL!,
});
const coinType = '0x2::sui::SUI';
const CLOCK_ID = '0x6';
const bcs_ser = new BCS(getSuiMoveConfig());
const messageEncoder = new MessageEncoder();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function publish(packagePath: string, signer: Ed25519Keypair): Promise<SuiTransactionBlockResponse> {
  const { modules, dependencies } = JSON.parse(
    execSync(`sui move build --dump-bytecode-as-base64 --path ${packagePath}`, {
      encoding: 'utf-8',
    }),
  );
  const tx = new TransactionBlock();
  const [upgradeCap] = tx.publish({
    modules,
    dependencies,
  });
  tx.transferObjects([upgradeCap], signer.toSuiAddress());
  const publishTxn = await client.signAndExecuteTransactionBlock({
    signer,
    transactionBlock: tx,
    options: {
      showInput: true,
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
  console.log('publishTxn', JSON.stringify(publishTxn, null, 2));
  return publishTxn;
}

async function sendTx(tx: TransactionBlock, signer: Ed25519Keypair): Promise<SuiTransactionBlockResponse> {
  const txnRes = await client.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    signer,
    options: {
      showInput: true,
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
  // console.log('txnRes', JSON.stringify(txnRes, null, 2));
  if (txnRes.effects?.status.status !== 'success') {
    console.log('txnRes', JSON.stringify(txnRes, null, 2));
    throw new Error(`transaction failed with error: ${txnRes.effects?.status.error}}`);
  }
  return txnRes;
}

async function prepareAmount(
  coinType: string,
  amount: bigint,
  sender: Ed25519Keypair,
): Promise<{ tx: TransactionBlock; txCoin: any }> {
  const senderAddr = sender.toSuiAddress();
  const isNative = coinType === '0x2::sui::SUI';
  let tx = new TransactionBlock();
  if (isNative) {
    const [txCoin] = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    return { tx, txCoin };
  }
  const { success, coins, totalAmount } = await getCoinsByAmount(senderAddr, coinType, amount);
  console.log({ success, coins, totalAmount });
  if (!success) {
    throw new Error(`not enough ${coinType}`);
  }
  let coin = tx.object(coins[0]);
  if (coins.length > 1) {
    tx.mergeCoins(
      coin,
      coins.slice(1).map((c) => tx.object(c)),
    );
  }
  const [txCoin] = tx.splitCoins(coin, [tx.pure(amount.toString())]);
  return { tx, txCoin };
}

// get coins whose value sum is greater than or equal to amount
async function getCoinsByAmount(
  owner: string,
  coinType: string,
  amount: bigint,
): Promise<{ success: boolean; coins: string[]; totalAmount: bigint }> {
  if (amount <= 0n) {
    throw new Error('amount must be greater than 0');
  }
  let coins: string[] = [];
  let totalAmount = 0n;
  let cursor: string | null = null;
  while (true) {
    let res = await client.getCoins({
      owner,
      coinType,
      cursor,
    });
    for (const coin of res.data) {
      coins.push(coin.coinObjectId);
      totalAmount += BigInt(coin.balance);
      if (totalAmount >= amount) {
        return { success: true, coins, totalAmount };
      }
    }
    if (!res.hasNextPage) {
      return { success: false, coins, totalAmount };
    }
  }
}

interface AppMeta {
  packageId: string;
  globalId: string;
}

let tx = new TransactionBlock();

async function publishClub(signer: Ed25519Keypair): Promise<AppMeta> {
  const publishTxn = await publish(path.join(__dirname, '.'), signer);
  const packageId = (publishTxn.objectChanges!.filter((o) => o.type === 'published')[0] as any).packageId;
  const globalId = (
    publishTxn.objectChanges!.filter((o) => o.type === 'created' && o.objectType.endsWith('::club::Global'))[0] as any
  ).objectId;
  return {
    packageId,
    globalId,
  };
}

interface ClubConfig {
  packageId: string;
  globalId: string;
}

interface ClubMsg {
  content: string;
  sender: string;
  timestamp: number;
  deleted: boolean;
}

interface ClubsByType {
  [type: string]: string[];
}

interface ClubInfo {
  name: string;
  logo: string;
  description: string;
  announcement: string;
  threshold: number;
  defaultChannelName: string;
  channels: string[];
  clubType: string;
}

interface UpdateClubInfoParams {
  name?: string;
  logo?: string;
  description?: string;
  announcement?: string;
  threshold?: number;
}

class Club {
  readonly packageId: string;
  readonly globalId: string;
  readonly client: SuiClient;

  constructor(config: ClubConfig, client: SuiClient) {
    this.packageId = config.packageId;
    this.globalId = config.globalId;
    this.client = client;
  }

  async createClub(
    signer: Ed25519Keypair,
    name: string,
    logo: string,
    description: string,
    announcement: string,
    threshold: number,
    defaultChannelName: string,
    typeName: string,
  ) {
    let tx = new TransactionBlock();
    const [fee] = tx.splitCoins(tx.gas, [tx.pure(1000000000n)]);
    tx.moveCall({
      target: `${this.packageId}::club::create_club`,
      arguments: [
        tx.object(this.globalId),
        fee,
        tx.pure(this.encodeUtf8(name)),
        tx.pure(this.encodeUtf8(logo)),
        tx.pure(this.encodeUtf8(description)),
        tx.pure(this.encodeUtf8(announcement)),
        tx.pure(threshold),
        tx.pure(this.encodeUtf8(defaultChannelName)),
      ],
      typeArguments: [typeName],
    });
    const createClubTxn = await sendTx(tx, signer);
    console.log('createClubTxn', JSON.stringify(createClubTxn, null, 2));
    return createClubTxn;
  }

  async addClubChannel(signer: Ed25519Keypair, clubId: string, channelName: string) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::add_club_channel`,
      arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(this.encodeUtf8(channelName))],
    });
    const addClubChannelTxn = await sendTx(tx, signer);
    console.log('addClubChannelTxn', JSON.stringify(addClubChannelTxn, null, 2));
    return addClubChannelTxn;
  }

  async deleteClubChannel(signer: Ed25519Keypair, clubId: string, channelIndex: number) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::delete_club_channel`,
      arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(channelIndex)],
    });
    const deleteClubChannelTxn = await sendTx(tx, signer);
    console.log('deleteClubChannelTxn', JSON.stringify(deleteClubChannelTxn, null, 2));
    return deleteClubChannelTxn;
  }

  async updateClubChannelName(signer: Ed25519Keypair, clubId: string, channelIndex: number, channelName: string) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::update_club_channel_name`,
      arguments: [
        tx.object(this.globalId),
        tx.object(clubId),
        tx.pure(channelIndex),
        tx.pure(this.encodeUtf8(channelName)),
      ],
    });
    const updateClubChannelNameTxn = await sendTx(tx, signer);
    console.log('updateClubChannelNameTxn', JSON.stringify(updateClubChannelNameTxn, null, 2));
    return updateClubChannelNameTxn;
  }

  encodeUtf8(data: string): Uint8Array {
    const encoder = new TextEncoder();
    const raw = encoder.encode(data);
    const param = bcs_ser.ser('vector<u8>', raw).toBytes();
    return param;
  }

  async newMessage(
    signer: Ed25519Keypair,
    clubId: string,
    channelIndex: number,
    message: string,
    messageType: MessageType,
  ) {
    let tx = new TransactionBlock();
    let msg = messageEncoder.encode(message, messageType);
    const msgParam = bcs_ser.ser('vector<u8>', msg).toBytes();
    tx.moveCall({
      target: `${this.packageId}::club::new_message`,
      arguments: [
        tx.object(CLOCK_ID),
        tx.object(this.globalId),
        tx.object(clubId),
        tx.pure(channelIndex),
        tx.pure(msgParam),
      ],
    });
    const newMessageTxn = await sendTx(tx, signer);
    console.log('newMessageTxn', JSON.stringify(newMessageTxn, null, 2));
    return newMessageTxn;
  }

  async deleteMessage(signer: Ed25519Keypair, clubId: string, channelIndex: number, messageIndex: number) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::delete_message`,
      arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(channelIndex), tx.pure(messageIndex)],
    });
    const deleteMessageTxn = await sendTx(tx, signer);
    console.log('deleteMessageTxn', JSON.stringify(deleteMessageTxn, null, 2));
    return deleteMessageTxn;
  }

  async addClubAdmin(signer: Ed25519Keypair, clubId: string, admin: string) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::add_club_admin`,
      arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(admin)],
    });
    const addClubAdminTxn = await sendTx(tx, signer);
    console.log('addClubAdminTxn', JSON.stringify(addClubAdminTxn, null, 2));
    return addClubAdminTxn;
  }

  async removeClubAdmin(signer: Ed25519Keypair, clubId: string, admin: string) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::remove_club_admin`,
      arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(admin)],
    });
    const removeClubAdminTxn = await sendTx(tx, signer);
    console.log('removeClubAdminTxn', JSON.stringify(removeClubAdminTxn, null, 2));
    return removeClubAdminTxn;
  }

  async updateClubInfo(signer: Ed25519Keypair, clubId: string, info: UpdateClubInfoParams) {
    let tx = new TransactionBlock();
    let { name, logo, description, announcement, threshold } = info;
    let updated = false;
    if (name !== undefined) {
      tx.moveCall({
        target: `${this.packageId}::club::update_club_name`,
        arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(this.encodeUtf8(name))],
      });
      updated = true;
    }
    if (logo !== undefined) {
      tx.moveCall({
        target: `${this.packageId}::club::update_club_logo`,
        arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(this.encodeUtf8(logo))],
      });
      updated = true;
    }
    if (description !== undefined) {
      tx.moveCall({
        target: `${this.packageId}::club::update_club_description`,
        arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(this.encodeUtf8(description))],
      });
      updated = true;
    }
    if (announcement !== undefined) {
      tx.moveCall({
        target: `${this.packageId}::club::update_club_announcement`,
        arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(this.encodeUtf8(announcement))],
      });
      updated = true;
    }
    if (threshold !== undefined) {
      tx.moveCall({
        target: `${this.packageId}::club::update_club_threshold`,
        arguments: [tx.object(this.globalId), tx.object(clubId), tx.pure(threshold)],
      });
      updated = true;
    }
    if (!updated) {
      throw new Error('no update info');
    }
    const updateClubInfoTxn = await sendTx(tx, signer);
    console.log('updateClubInfoTxn', JSON.stringify(updateClubInfoTxn, null, 2));
    return updateClubInfoTxn;
  }

  async getAllClubsByType(): Promise<ClubsByType> {
    const global = await client.getObject({
      id: this.globalId,
      options: {
        showContent: true,
      },
    });
    // console.log('global', JSON.stringify(global, null, 2));
    const clubsTypeIndexerId = (global.data!.content as any).fields.clubs_type_indexer.fields.id.id;
    let cursor: string | null = null;
    let clubsByType: ClubsByType = {};
    while (true) {
      const res = await client.getDynamicFields({
        parentId: clubsTypeIndexerId,
        cursor,
      });
      for (const club of res.data) {
        // console.log('club', JSON.stringify(club, null, 2));
        const valueObj = await client.getDynamicFieldObject({
          parentId: clubsTypeIndexerId,
          name: club.name,
        });
        // console.log('valueObj', JSON.stringify(valueObj, null, 2));
        const type = (valueObj.data!.content as any).fields.name;
        const clubIds = (valueObj.data!.content as any).fields.value;
        clubsByType[type] = clubIds;
      }
      if (!res.hasNextPage) {
        break;
      }
      cursor = res.nextCursor;
    }
    return clubsByType;
  }

  async getClubInfoById(clubId: string): Promise<SuiObjectData | null | undefined> {
    const clubObj = await client.getObject({
      id: clubId,
      options: {
        showContent: true,
      },
    });
    // console.log('clubObj', JSON.stringify(clubObj, null, 2));
    return clubObj?.data;
  }

  async getClubIdByIndex(index: number): Promise<string | null | undefined> {
    tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::get_club_by_index`,
      arguments: [tx.object(this.globalId), tx.pure(index)],
    });
    const res = await client.devInspectTransactionBlock({
      sender: '0x36e278bb555e0501cb58e24561ae4af32d624d526fa565ab21dc366eae1e22b1', // a random sender
      transactionBlock: tx,
    });
    // console.log('getClubIdByIndex', JSON.stringify(res.results, null, 2));
    const serData = Uint8Array.from((res as any).results[0].returnValues[0][0]);
    // const serType = (res as any).results[0].returnValues[0][1]
    // console.log('serData', serData);
    // console.log('serType', serType);
    // bcs_ser.registerStructType('0x2::object::ID', {
    //   bytes: 'address',
    // })
    const clubId = bcs_ser.de('address', serData);
    return `0x${clubId}`;
  }

  async getClubsByOwner(owner: string): Promise<string[]> {
    tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::get_clubs_by_owner`,
      arguments: [tx.object(this.globalId), tx.pure(owner)],
    });
    const res = await client.devInspectTransactionBlock({
      sender: '0x36e278bb555e0501cb58e24561ae4af32d624d526fa565ab21dc366eae1e22b1', // a random sender
      transactionBlock: tx,
    });
    const serData = Uint8Array.from((res as any).results[0].returnValues[0][0]);
    // const serType = (res as any).results[0].returnValues[0][1]
    // console.log('serData', serData);
    // console.log('serType', serType);
    // bcs_ser.registerStructType('0x2::object::ID', {
    //   bytes: 'address',
    // })
    const data = bcs_ser.de('vector<address>', serData);
    // console.log('data', data);
    return data.map((d: any) => `0x${d}`);
  }

  async getClubsByType(type: string): Promise<string[]> {
    tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::club::get_clubs_by_type`,
      arguments: [tx.object(this.globalId)],
      typeArguments: [type],
    });
    const res = await client.devInspectTransactionBlock({
      sender: '0x36e278bb555e0501cb58e24561ae4af32d624d526fa565ab21dc366eae1e22b1', // a random sender
      transactionBlock: tx,
    });
    const serData = Uint8Array.from((res as any).results[0].returnValues[0][0]);
    // const serType = (res as any).results[0].returnValues[0][1]
    // console.log('serData', serData);
    // console.log('serType', serType);
    // bcs_ser.registerStructType('0x2::object::ID', {
    //   bytes: 'address',
    // })
    const data = bcs_ser.de('vector<address>', serData);
    // console.log('data', data);
    return data.map((d: any) => `0x${d}`);
  }

  async getClubChannelMsgs(clubId: string, channelIndex: number, offset: number, limit: number): Promise<ClubMsg[]> {
    const clubInfo = await this.getClubInfoById(clubId);
    if (!clubInfo) {
      throw new Error(`club ${clubId} not found`);
    }
    const channels = (clubInfo.content as any).fields.channels;
    if (channelIndex >= channels.length) {
      throw new Error(`channel ${channelIndex} not found`);
    }
    const channel = channels[channelIndex];
    console.log('channel', JSON.stringify(channel, null, 2));
    const channelMsgTableId = channel.fields.messages.fields.contents.fields.id.id;
    console.log('channelMsgTableId', channelMsgTableId);
    return await this.getMsgs(channelMsgTableId, offset, limit);
  }

  async getMsg(clubMsgTableId: string, index: number): Promise<ClubMsg | null> {
    const msg = await client.getDynamicFieldObject({
      parentId: clubMsgTableId,
      name: {
        type: 'u64',
        value: index.toString(),
      },
    });
    let clubMsg: ClubMsg | null = null;
    if (msg.error) {
      return clubMsg;
    }
    // console.log('msg', JSON.stringify(msg, null, 2));
    const content = (msg.data!.content as any).fields.value.fields;
    clubMsg = {
      content: '',
      sender: content.sender,
      timestamp: parseInt(content.timestamp),
      deleted: content.deleted,
    };
    if (!clubMsg.deleted) {
      clubMsg.content = messageEncoder.decode(Uint8Array.from(content.content));
    }
    return clubMsg;
  }

  async getMsgs(clubMsgTableId: string, offset: number, limit: number): Promise<ClubMsg[]> {
    const futures = [];
    for (let i = offset; i < offset + limit; i++) {
      futures.push(this.getMsg(clubMsgTableId, i));
    }
    const msgs = await Promise.all(futures);
    return msgs.filter((m) => m !== null) as ClubMsg[];
  }
}

async function interact(appMeta: AppMeta, signer: Ed25519Keypair, user: Ed25519Keypair) {
  // create club
  const club = new Club(appMeta, client);
  const clubRes = await club.createClub(
    signer,
    '1 mist sui club',
    'logo',
    '测试一下中文和  😯 的 description',
    '测试一下中文和 😯 的 announcement',
    1,
    'default',
    '0x2::coin::Coin<0x2::sui::SUI>',
  );
  const createClubEvent = clubRes.events![0].parsedJson;
  console.log('createClubEvent', JSON.stringify(createClubEvent, null, 2));
  const clubId = (createClubEvent as any).id;
  // add club admin
  await club.addClubAdmin(signer, clubId, user.toSuiAddress());
  // remove club admin
  await club.removeClubAdmin(signer, clubId, user.toSuiAddress());
  // update club info
  await club.updateClubInfo(signer, clubId, {
    name: '2 mist sui club',
    logo: 'new logo',
    description: '新的 description',
    threshold: 2,
  });
  // create channel
  await club.addClubChannel(signer, clubId, '中文');
  // update channel name
  await club.updateClubChannelName(signer, clubId, 0, '默认');
  // delete channel
  await club.deleteClubChannel(signer, clubId, 1);
}

async function queries(appMeta: AppMeta) {
  const club = new Club(appMeta, client);
  // get all clubs by owner
  const clubsByOwner = await club.getClubsByOwner(admin.toSuiAddress());
  console.log('clubsByOwner', JSON.stringify(clubsByOwner, null, 2));
  // get club id by index
  const clubIdByIndex = await club.getClubIdByIndex(0);
  console.log('clubIdByIndex: ', clubIdByIndex);
  // list all clubs by type
  const clubsByType = await club.getAllClubsByType();
  console.log('clubsByType', JSON.stringify(clubsByType, null, 2));
  let clubId = '';
  for (const type in clubsByType) {
    const clubIds = clubsByType[type];
    console.log(`type: ${type}, clubIds: ${clubIds.join(', ')}`);
    clubId = clubIds[0];
  }
  const suiClubs = await club.getClubsByType('0x2::coin::Coin<0x2::sui::SUI>');
  console.log('suiClubs', JSON.stringify(suiClubs, null, 2));
  const suiClubs2 = await club.getClubsByType(
    '0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>',
  );
  console.log('suiClubs2', JSON.stringify(suiClubs2, null, 2));
  const suiClubs3 = await club.getClubsByType(
    '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>',
  );
  console.log('suiClubs3', JSON.stringify(suiClubs3, null, 2));
  // get one club info
  const clubInfo = await club.getClubInfoById(clubId);
  console.log('clubInfo', JSON.stringify(clubInfo, null, 2));
}

async function main() {
  console.log('-----start-----');
  const addr = admin.toSuiAddress();
  console.log(`admin address: ${addr}`);
  console.log(`user address: ${user.toSuiAddress()}`);
  // faucet
  if (process.env.REQUEST_SUI) {
    await requestSuiFromFaucetV0({
      host: process.env.FAUCET_URL!,
      recipient: addr,
    });
    await requestSuiFromFaucetV0({
      host: process.env.FAUCET_URL!,
      recipient: user.toSuiAddress(),
    });
  }

  // get balance
  const balance = await client.getBalance({
    owner: addr,
  });
  console.log({ balance });

  // publish
  const appMeta = await publishClub(admin);
  // const appMeta = {
  //   packageId: '0x81b4219558355f78d68e7bb630a2505c9a855a66bba613a36b5b0c8efaeca536',
  //   globalId: '0x16dc2171343753f936e227c986b14ad0b145e2524339e370b46bd4d94692f072',
  // };

  console.log(`appMeta: ${JSON.stringify(appMeta, null, 2)}`);

  // club txs
  await interact(appMeta, admin, user);
  await queries(appMeta);

  console.log('-----end-----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`error: ${JSON.stringify(error, null, 2)}, ${error.stack}`);
    process.exit(1);
  });
