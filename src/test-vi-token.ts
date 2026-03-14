import axios from 'axios';
import { DefaultAzureCredential } from '@azure/identity';
import * as dotenv from 'dotenv';

dotenv.config();

async function testToken() {
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
    const viName = process.env.AZURE_VI_NAME;

    console.log('Using:');
    console.log('Subscription:', subscriptionId);
    console.log('Resource Group:', resourceGroup);
    console.log('VI Name:', viName);

    const credential = new DefaultAzureCredential();
    try {
        const tokenObj = await credential.getToken('https://management.azure.com/.default');
        const armToken = tokenObj.token;
        console.log('Got ARM Token successfully.');

        const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.VideoIndexer/accounts/${viName}/generateAccessToken?api-version=2024-01-01`;

        const response = await axios.post(
            url,
            { permissionType: 'Contributor', scope: 'Account' },
            { headers: { Authorization: `Bearer ${armToken}` } }
        );

        console.log('Success!', response.data);
    } catch (err: any) {
        console.error('Error Status:', err.response?.status);
        console.error('Error Data:', JSON.stringify(err.response?.data, null, 2));
        if (!err.response) {
            console.error('Full Error:', err);
        }
    }
}

testToken();
