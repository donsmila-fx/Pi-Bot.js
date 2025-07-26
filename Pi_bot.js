const { Horizon, Keypair, TransactionBuilder, Operation, Asset } = require('@stellar/stellar-sdk');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');

// Load environment variables
dotenv.config();

// Configuration
const config = {
  mnemonic: process.env.MNEMONIC || '', // 24-word mnemonic phrase
  destination: process.env.DESTINATION_ADDRESS || '', // Destination address (G... or M...)
  amount: process.env.AMOUNT || '1.5', // Amount to withdraw (Pi)
  stellarServer: 'https://api.mainnet.minepi.com',
  networkPassphrase: 'Pi Network',
  maxRetries: 5, // Retries for failed transactions
  retryDelay: 1000, // 1 second between retries
  checkInterval: 5000, // 5 seconds between attempts
  logFile: path.join(__dirname, 'pi_bot.log')
};

// Initialize Stellar server
const server = new Horizon.Server(config.stellarServer, { allowHttp: false });

// Logging function
async function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  try {
    await fs.appendFile(config.logFile, logMessage);
  } catch (error) {
    console.error(`[${timestamp}] Failed to write log: ${error.message}`);
  }
}

// Convert mnemonic to secret key
function mnemonicToSecretKey(mnemonic) {
  try {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const derived = edHd.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    const keypair = Keypair.fromRawEd25519Seed(derived.key);
    return { secret: keypair.secret(), publicKey: keypair.publicKey() };
  } catch (error) {
    throw new Error(`Failed to derive secret key: ${error.message}`);
  }
}

// Get Pi blockchain base fee
async function getNetworkBaseFee() {
  try {
    const ledger = await server.ledgers().order('desc').limit(1).call();
    const baseFee = ledger.records[0].base_fee_in_stroops || 100000; // Fallback 0.1 Pi
    await log(`Fetched network base fee: ${baseFee} stroops (${baseFee / 1000000} PI)`);
    return baseFee.toString();
  } catch (error) {
    await log(`Failed to fetch network fee, using fallback 0.1 Pi: ${error.message}`);
    return '100000'; // Fallback 0.1 Pi
  }
}

// Check balances (native and claimable)
async function checkBalances(keypair) {
  try {
    const account = await server.loadAccount(keypair.publicKey());
    const piBalance = account.balances.find(b => b.asset_type === 'native');
    const availableBalance = piBalance ? parseFloat(piBalance.balance) : 0;
    const requiredAmount = parseFloat(config.amount);
    const fee = parseFloat(await getNetworkBaseFee()) / 1000000 * 2; // Fee for 2 operations (claim + payment)

    // Check for claimable balances
    let claimableBalance = null;
    try {
      const claimable = await server.claimableBalances().forClaimant(keypair.publicKey()).call();
      // Filter for unlocked claimable balances (no time-based predicates)
      claimableBalance = claimable.records.find(cb => {
        if (cb.asset === 'native' && parseFloat(cb.amount) >= requiredAmount) {
          const predicates = cb.claimants.find(c => c.destination === keypair.publicKey())?.predicate;
          const isClaimable = !predicates || !predicates.not || !predicates.not.abs_before;
          return isClaimable;
        }
        return false;
      });
      if (claimableBalance) {
        await log(`Found unlocked claimable balance: ${claimableBalance.amount} PI, ID: ${claimableBalance.id}`);
      } else {
        await log(`No unlocked claimable balance found for ${requiredAmount} PI or more.`);
      }
    } catch (error) {
      await log(`Error checking claimable balances: ${error.message}`);
    }

    if (!claimableBalance) {
      await log(`No unlocked claimable balance available. Native: ${availableBalance} PI, required: ${requiredAmount + fee} PI. Awaiting lockup release.`);
      return { sufficient: false, availableBalance, claimableBalance: null };
    }

    if (availableBalance < fee) {
      await log(`Found claimable balance: ${claimableBalance.amount} PI, but insufficient native balance for fee: ${availableBalance} PI, required: ${fee} PI.`);
      return { sufficient: false, availableBalance, claimableBalance };
    }

    await log(`Sufficient funds for transaction: Native: ${availableBalance} PI, Claimable: ${claimableBalance.amount} PI`);
    return { sufficient: true, availableBalance, claimableBalance };
  } catch (error) {
    throw new Error(`Error checking balances: ${error.message}`);
  }
}

// Perform claim and withdrawal in one transaction
async function performClaimAndWithdrawal(keypair, amount, destination, claimableBalance) {
  try {
    const account = await server.loadAccount(keypair.publicKey());
    const fee = await getNetworkBaseFee();
    const totalFee = (parseInt(fee) * 2).toString(); // Fee for 2 operations
    const txBuilder = new TransactionBuilder(account, {
      fee: totalFee,
      networkPassphrase: config.networkPassphrase
    });

    // Add claim operation
    txBuilder.addOperation(Operation.claimClaimableBalance({
      balanceId: claimableBalance.id
    }));

    // Add payment operation
    txBuilder.addOperation(Operation.payment({
      destination,
      asset: Asset.native(),
      amount: amount.toString()
    }));

    const tx = txBuilder.setTimeout(10).build();
    tx.sign(keypair);

    let attempt = 0, success = false;
    while (attempt < config.maxRetries && !success) {
      try {
        const result = await server.submitTransaction(tx);
        await log(`Claim and withdrawal successful! Hash: ${result.hash}, Amount: ${amount} PI, Destination: ${destination}, Fee: ${parseFloat(totalFee / 1000000)} PI, Claimed ID: ${claimableBalance.id}`);
        return result;
      } catch (error) {
        attempt++;
        if (attempt === config.maxRetries) {
          throw new Error(`Transaction failed after ${config.maxRetries} tries: ${error.message}`);
        }
        await log(`Retry ${attempt}/${config.maxRetries}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, config.retryDelay));
      }
    }
  } catch (error) {
    throw error;
  }
}

// Main function
async function main() {
  try {
    // Validate configuration
    if (!config.mnemonic || !config.destination || !config.amount) {
      throw new Error('Missing MNEMONIC, DESTINATION_ADDRESS, or AMOUNT in .env');
    }

    // Convert mnemonic to secret key
    let keypairData;
    try {
      keypairData = mnemonicToSecretKey(config.mnemonic);
      await log(`Successfully derived secret key, public key: ${keypairData.publicKey}`);
    } catch (error) {
      throw new Error(error.message);
    }

    let keypair;
    try {
      keypair = Keypair.fromSecret(keypairData.secret);
      await log(`Initialized with public key: ${keypair.publicKey()}`);
    } catch (error) {
      throw new Error('Invalid derived secret key');
    }

    // Validate destination address
    try {
      if (!Keypair.fromPublicKey(config.destination)) {
        throw new Error('Invalid destination address');
      }
    } catch (error) {
      throw new Error(`Invalid DESTINATION_ADDRESS: ${error.message}`);
    }

    // Initial balance check
    try {
      const { sufficient, availableBalance, claimableBalance } = await checkBalances(keypair);
      if (!sufficient) {
        await log(`Initial check: Insufficient funds: Native: ${availableBalance} PI${claimableBalance ? `, Claimable: ${claimableBalance.amount} PI` : ''}. Awaiting lockup release, will retry.`);
      } else {
        await log(`Initial check: Sufficient funds: Native: ${availableBalance} PI, Claimable: ${claimableBalance.amount} PI, ready for transaction.`);
      }
    } catch (error) {
      await log(`Initial balance check failed: ${error.message}`);
    }

    // Continuous claim and withdrawal attempts
    async function attemptClaimAndWithdrawal() {
      try {
        const { sufficient, availableBalance, claimableBalance } = await checkBalances(keypair);
        await log(`Attempting claim and withdrawal: Native Balance: ${availableBalance} PI${claimableBalance ? `, Claimable: ${claimableBalance.amount} PI` : ''}, Required: ${config.amount} PI`);

        if (sufficient && claimableBalance) {
          try {
            await performClaimAndWithdrawal(keypair, config.amount, config.destination, claimableBalance);
            await log('Transaction succeeded, continuing to monitor for additional unlocked Pi');
          } catch (error) {
            await log(`Transaction failed: ${error.message}`);
          }
        } else {
          await log(`Cannot proceed: ${!claimableBalance ? 'No unlocked claimable balance found' : 'Insufficient native balance for fee'}. Native: ${availableBalance} PI${claimableBalance ? `, Claimable: ${claimableBalance.amount} PI` : ''}. Awaiting lockup release.`);
        }
      } catch (error) {
        await log(`Error during attempt: ${error.message}`);
      }

      // Schedule next attempt
      setTimeout(attemptClaimAndWithdrawal, config.checkInterval);
    }

    await log('Starting Pi Network claim and withdrawal bot...');
    attemptClaimAndWithdrawal();
  } catch (error) {
    await log(`Initialization error: ${error.message}`);
    process.exit(1);
  }
}

// Run bot
main();

// Graceful shutdown
process.on('SIGINT', async () => {
  await log('Shutting down bot...');
  process.exit(0);
});
