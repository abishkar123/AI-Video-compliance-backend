import axios from 'axios';
import { DefaultAzureCredential } from '@azure/identity';
import * as dotenv from 'dotenv';

dotenv.config();

async function listSubscriptions() {
    const credential = new DefaultAzureCredential();
    try {
        const tokenObj = await credential.getToken('https://management.azure.com/.default');
        const armToken = tokenObj.token;

        console.log('Fetching subscriptions...');
        const url = 'https://management.azure.com/subscriptions?api-version=2020-01-01';

        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${armToken}` }
        });

        console.log('Found subscriptions:');
        console.log(JSON.stringify(response.data.value.map((s: any) => ({
            displayName: s.displayName,
            subscriptionId: s.subscriptionId,
            state: s.state
        })), null, 2));
    } catch (err: any) {
        console.error('Error:', err.response?.data || err.message);
    }
}

listSubscriptions();
