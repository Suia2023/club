import { SuiClient } from '@mysten/sui.js/client';
import { KioskClient, Network } from '@mysten/kiosk';
import * as process from 'process';

require('dotenv').config();

const ENDPOINT = 'https://fullnode.mainnet.sui.io:443';

async function getNftBalance({
  owner,
  nftType,
  apiKey,
  client,
}: {
  owner: string;
  nftType: string;
  apiKey: string;
  client: SuiClient;
}) {
  const [normalNFTs, kioskNFTs] = await Promise.all([
    getNormalNftBalance({ owner, nftType, client }),
    getKioskNftBalance({ owner, nftType, apiKey }),
  ]);
  return normalNFTs + kioskNFTs;
}

async function getNormalNftBalance({
  owner,
  nftType,
  client,
}: {
  owner: string;
  nftType: string;
  client: SuiClient;
}): Promise<number> {
  let res = 0;
  let cursor = null;
  while (true) {
    const response = await client.getOwnedObjects({
      owner,
      filter: {
        StructType: nftType,
      },
      cursor,
      // options: {
      //  showType: true,
      // }
    });
    // console.log(`response: ${JSON.stringify(response, null, 2)}`)
    res += response.data.length;
    if (!response.hasNextPage) {
      return res;
    }
    cursor = response.nextCursor;
  }
}

async function getKioskNftBalance({ owner, nftType, apiKey }: { owner: string; nftType: string; apiKey: string }) {
  const options = {
    method: 'GET',
    headers: { accept: 'application/json', 'x-api-key': apiKey },
  };

  let page = 1;
  let numberOfNFTs = 0;
  while (true) {
    let url = `https://api.blockvision.org/v2/sui/account/nfts?account=${owner}&type=kiosk&pageIndex=${page}&pageSize=50`;
    // console.log(`url: ${url}, options: ${JSON.stringify(options, null, 2)}`)
    const data = await fetch(url, options);
    const json = await data.json();
    // console.log(`json: ${JSON.stringify(json, null, 2)}`)
    numberOfNFTs += json.result.data.filter((nft: any) => nft.collection === nftType).length;
    const nextPage = json.result.nextPageIndex;
    if (nextPage === page) {
      return numberOfNFTs;
    } else {
      page = nextPage;
    }
  }
}

async function main() {
  const client = new SuiClient({
    url: ENDPOINT,
  });
  const kioskClient = new KioskClient({
    client,
    network: Network.MAINNET,
  });
  const address = '0x932eb6426af8b99fd2a18373bb6b51d66ac5917ec345e89f10bc14ba6385c901';
  // ============ Get the balance of the token ============
  const suiaType = '0x1d58e26e85fbf9ee8596872686da75544342487f95b1773be3c9a49ab1061b19::suia_token::SUIA_TOKEN';
  const suiaBalance = await client.getBalance({ owner: address, coinType: suiaType });
  console.log(`SUIA Balance: ${JSON.stringify(suiaBalance, null, 2)}`);
  // ============ Get nft balance ============
  const addr = '0x40cdfd49d252c798833ddb6e48900b4cd44eeff5f2ee8e5fad76b69b739c3e62';
  const apiKey = process.env.BLOCKVISION_API_KEY!;
  const getNFTsRes = await getNftBalance({
    owner: addr,
    // nftType: '0xee496a0cc04d06a345982ba6697c90c619020de9e274408c7819f787ff66e1a1::suifrens::SuiFren<0xee496a0cc04d06a345982ba6697c90c619020de9e274408c7819f787ff66e1a1::capy::Capy>',
    // nftType:
    //   '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration',
    nftType: '0x4edaf43ada89b42ba4dee9fbf74a4dee3eb01f3cfd311d4fb2c6946f87952e51::dlab::Dlab',
    apiKey,
    client,
  });
  console.log(`NFTs: ${getNFTsRes}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`error: ${JSON.stringify(error, null, 2)}, ${error.stack}`);
    process.exit(1);
  });
