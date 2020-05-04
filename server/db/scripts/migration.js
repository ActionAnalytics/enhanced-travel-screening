/* eslint-disable */
const AWS = require('aws-sdk');
const { dbClient, collections } = require('..');

// Run DynamoDB locally: docker run -p 8000:8000 amazon/dynamodb-local
const databaseSuffix = process.env.DB_SUFFIX || 'development';
const nodeEnv = process.env.NODE_ENV || 'development';
AWS.config.update({
  region: 'ca-central-1',
  ...(nodeEnv === 'development' && {
    endpoint: 'http://dynamoDB:8000',
    accessKeyId: 'Abc', // Must be not null
    secretAccessKey: 'Abc', // Must be not null
  }),
  credentials: new AWS.SharedIniFileCredentials({ profile: 'covid' }),
});
const db = new AWS.DynamoDB();
const dynamoClient = new AWS.DynamoDB.DocumentClient();

// DynamoDB
const usersTable = `ets-users-${databaseSuffix}`;
const formsTable = `ets-forms-${databaseSuffix}`;
const serviceBCTable = `ets-servicebc-${databaseSuffix}`;

const keypress = async () => {
  process.stdin.setRawMode(false);
  return new Promise((resolve) => process.stdin.once('data', (chunk, key) => {
    if (key && key.name === 'c' && key.ctrl) {
      console.log('Aborting...');
      return process.exit();
    }
    resolve();
  }));
};

// Recursively scan DynamoDB paginated results
const exportData = async (table, nextKey = false) => {
  const params = {
    TableName: table,
    ...(nextKey && { ExclusiveStartKey: nextKey }),
  };
  const request = await dynamoClient.scan(params).promise();
  const items = request.Items;
  if (request.LastEvaluatedKey) items.push(...(await exportData(table, request.LastEvaluatedKey)));
  return items;
};

async function migrateUsers() {
  const usersCollection = dbClient.db.collection(collections.USERS);

  // This could be improved by using a paginated scan but
  // considering we have less than 2MB of data, this should be okay
  console.log('Loading DynamoDB users into memory...');
  const dynamoUsers = await exportData(usersTable);

  console.log('\nMigrating users...');
  const totalUsers = dynamoUsers.length;
  let processedUsers = 0;
  let addedUsers = 0;
  let redundantUsers = 0;
  let failedUsers = 0;

  if (dynamoUsers) {
    for (const item of dynamoUsers) {
      try {
        // Check if user exists in MongoDB
        await usersCollection.insertOne(
          {
            username: item.id,
            password: item.password,
            salt: item.salt,
          },
        );

        addedUsers += 1;
      } catch (err) {
        // Failed due to duplicated Key
        if (err.code === 11000) {
          redundantUsers += 1;
        } else {
          console.log('Failed to migrate item: ', item, err);
          failedUsers += 1;
        }
      }

      processedUsers += 1;
    }
  }

  console.log('User Migration summary\n', {
    totalUsers, processedUsers, addedUsers, redundantUsers, failedUsers,
  });
}

async function migrateForms() {
  const formsCollection = dbClient.db.collection(collections.FORMS);

  // This could be improved by using a paginated scan but
  // considering we have less than 2MB of data, this should be okay
  console.log('Loading DynamoDB forms into memory...');
  const dynamoForms = await exportData(formsTable);

  console.log('Loading DynamoDB serviceBC items into memory...');
  const dynamoServiceBCItems = await exportData(serviceBCTable);

  console.log('\nMigrating forms...');
  const total = dynamoForms.length;
  let processed = 0;
  let added = 0;
  let redundant = 0;
  let failed = 0;

  const currentDate = new Date().toISOString();

  if (dynamoForms) {
    for (const item of dynamoForms) {
      try {
        const { created_at, updated_at, ...formData } = item;

        // Try to find serviceBC for request
        const serviceBCTransactionsForForm = dynamoServiceBCItems.filter((serviceBCItem) => serviceBCItem.confirmationId === formData.id);

        // Convert current BC transaction format
        const serviceBCTransactions = serviceBCTransactionsForForm.map((item) => ({
          ...(item.serviceBCId && {serviceBCId: item.serviceBCId}),
          ...(item.errorDetails && {errorDetails: item.errorDetails}),
          processedAt: item.createdAt,
          status: item.status,
        }));

        const formDate = serviceBCTransactions.length > 0 ? serviceBCTransactions[0].processedAt : currentDate;

        // Check if user exists in MongoDB
        await formsCollection.insertOne(
          {
            ...formData,
            serviceBCTransactions,
            createdAt: created_at || updated_at || formDate || currentDate,
            updatedAt: updated_at || created_at || formDate || currentDate,
          },
        );

        added += 1;
      } catch (err) {
        // Failed due to duplicated Key
        if (err.code === 11000) {
          redundant += 1;
        } else {
          console.log('Failed to migrate item: ', item, err);
          failed += 1;
        }
      }

      processed += 1;
    }
  }

  console.log('Forms Migration summary\n', {
    total, processed, added, redundant, failed,
  });
}

/* eslint-disable no-console */
(async () => {
  if (require.main !== module) {
    console.error('Migration module cannot be imported.');
    return process.exit();
  }

  try {
    console.log('Starting db migration');

    console.log('Current mongo config are: ');
    dbClient.printConfig();

    console.log('\nCurrent dynamoDB config are: ');
    console.log(`Endpoint: ${AWS.config.endpoint}`);
    console.log(`User table: ${usersTable}`);
    console.log(`Form table: ${formsTable}`);
    console.log(`SBC table: ${serviceBCTable}`);

    console.log('\n\nDouble check configuration.\nPress any key to continue or CTRL + C to abort.');
    await keypress();

    console.log('Connecting with mongo db...\n');
    await dbClient.connect();

    console.log('Verifying DynamoDB tables...\n');
    const tables = await db.listTables().promise();

    console.log(tables);
    if (!Array.isArray(tables.TableNames)
      || !tables.TableNames.includes(formsTable)
      || !tables.TableNames.includes(usersTable)
    ) {
      console.log('Missing DynamoDB tables\n');
      return process.exit();
    }

    await migrateUsers();
    await migrateForms();

    process.exit();
  } catch (err) {
    console.error('Migration script failed with: ', err);
  }
})();
/* eslint-enable no-console */
