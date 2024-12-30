let leftDevice = null;
let rightDevice = null;
const TEXT_COMMAND = 0x4E;
const SCREEN_STATUS = 0x71;  // 0x70 (Text Show) | 0x01 (Display new content)


const SERVICE_UUID =  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
const WRITE_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
const READ_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async function scanAndConnect() {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: "Even" }
            ],
            optionalServices: [SERVICE_UUID] 
        });

        updateStatus('Device found. Connecting...');
        
        const server = await device.gatt.connect();
        updateStatus('Connected to device');
        
        const service = await server.getPrimaryService(SERVICE_UUID);
        const characteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
        
        return { device, characteristic };
    } catch (error) {
        updateStatus('Error: ' + error);
        throw error;
    }
}

async function ensureConnected(device) {
    if (!device.gatt.connected) {
        updateStatus('Reconnecting...');
        await device.gatt.connect();
    }
    return device;
}

const MAX_PACKAGE_SIZE = 20; 

async function sendText(deviceInfo, text) {
    try {
        await ensureConnected(deviceInfo.device);
        
        const textBytes = new TextEncoder().encode(text);
        
        const totalPackages = Math.ceil(textBytes.length / MAX_PACKAGE_SIZE);
        if (totalPackages > 255) {
            throw new Error('Text too long - exceeds maximum package count');
        }

        const seq = Math.floor(Math.random() * 256);
        
        for (let i = 0; i < totalPackages; i++) {
            const start = i * MAX_PACKAGE_SIZE;
            const end = Math.min(start + MAX_PACKAGE_SIZE, textBytes.length);
            const packageData = textBytes.slice(start, end);
            
            const data = new Uint8Array([
                TEXT_COMMAND,     
                seq,             
                totalPackages,   
                i,              
                SCREEN_STATUS,   
                0x00,           
                0x00,           
                0x00,           
                0x01,           
                ...packageData  
            ]);
            
            await deviceInfo.characteristic.writeValue(data);
            updateStatus(`Sent package ${i + 1} of ${totalPackages}`);
            
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        updateStatus('Message sent successfully');
    } catch (error) {
        updateStatus('Error sending message: ' + error);
        throw error;
    }
}

function updateStatus(message) {
    document.getElementById('status').textContent = message;
}

function setupDisconnectListener(device, side) {
    device.addEventListener('gattserverdisconnected', () => {
        updateStatus(`${side} device disconnected`);
        document.getElementById('sendTextButton').disabled = true;
    });
}

document.getElementById('scanButton').addEventListener('click', async () => {
    try {
        updateStatus('Scanning for left device...');
        const left = await scanAndConnect();
        leftDevice = left;
        
        updateStatus('Scanning for right device...');
        const right = await scanAndConnect();
        rightDevice = right;
        
        document.getElementById('sendTextButton').disabled = false;
        updateStatus('Both devices connected and ready');
    } catch (error) {
        updateStatus('Error during scanning: ' + error);
    }
});

document.getElementById('sendTextButton').addEventListener('click', async () => {
    const message = document.getElementById('messageInput').value;
    if (!message) {
        updateStatus('Please enter a message');
        return;
    }
    
    try {
        if (leftDevice) {
            await sendText(leftDevice, message);
        }
        if (rightDevice) {
            await sendText(rightDevice, message);
        }
    } catch (error) {
        updateStatus('Error sending message: ' + error);
        document.getElementById('sendTextButton').disabled = true;
    }
});

async function disconnectDevices() {
    try {
        if (leftDevice && leftDevice.device.gatt.connected) {
            await leftDevice.device.gatt.disconnect();
            leftDevice = null;
        }
        if (rightDevice && rightDevice.device.gatt.connected) {
            await rightDevice.device.gatt.disconnect();
            rightDevice = null;
        }
        document.getElementById('sendTextButton').disabled = true;
        updateStatus('Devices disconnected');
    } catch (error) {
        updateStatus('Error disconnecting: ' + error);
    }
}

document.getElementById('disconnectButton').addEventListener('click', disconnectDevices);