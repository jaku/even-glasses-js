let leftDevice = null;
let rightDevice = null;
const TEXT_COMMAND = 0x4E;
const SCREEN_STATUS = 0x71;  // 0x70 (Text Show) | 0x01 (Display new content)

const SERVICE_UUID =  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
const WRITE_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
const READ_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

const LEFT_PREFIX = "Even G1_";
const RIGHT_PREFIX = "Even G1_";

const BMP_DATA_COMMAND = 0x15;
const BMP_END_COMMAND = 0x20;
const BMP_CRC_COMMAND = 0x16;
const BMP_ADDRESS = [0x00, 0x1c, 0x00, 0x00];
const BMP_PACKET_SIZE = 194;

const HEARTBEAT_COMMAND = 0x25;
const HEARTBEAT_INTERVAL = 5000; 
let heartbeatSeq = 0;

let heartbeatIntervals = {
    left: null,
    right: null
};

const CRC32_TABLE = new Uint32Array(256);

(function initCRC32Table() {
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        CRC32_TABLE[i] = c;
    }
})();

function crc32(data) {
    let crc = 0xFFFFFFFF;
    
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
    }
    
    crc = ~crc >>> 0;
    
    return new Uint8Array([
        (crc >>> 24) & 0xFF,
        (crc >>> 16) & 0xFF,
        (crc >>> 8) & 0xFF,
        crc & 0xFF
    ]);
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 1000; // 1 second

async function sendHeartbeat(deviceInfo, side) {
    try {
        if (!deviceInfo.device.gatt.connected) {
            console.log(`${side} device disconnected, attempting reconnect...`);
            await reconnectDevice(deviceInfo, side);
            return;
        }

        const length = 6;
        const seq = heartbeatSeq % 0xff;
        
        const packet = new Uint8Array([
            HEARTBEAT_COMMAND,
            length & 0xff,
            (length >> 8) & 0xff,
            seq,
            0x04,
            seq
        ]);
        
        heartbeatSeq++;

        console.log(`[${new Date().toISOString()}] Heartbeat sent to ${side}: ${Array.from(packet).map(b => b.toString(16).padStart(2, '0')).join('')}`);
        
        await deviceInfo.writeCharacteristic.writeValueWithoutResponse(packet);
    } catch (error) {
        console.log(`[${new Date().toISOString()}] Failed to send heartbeat to ${side}: ${error}`);
        await reconnectDevice(deviceInfo, side);
    }
}

async function reconnectDevice(deviceInfo, side) {
    let attempts = 0;
    while (attempts < MAX_RECONNECT_ATTEMPTS) {
        try {
            if (!deviceInfo.device.gatt.connected) {
                console.log(`Attempting to reconnect ${side} device (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
                await deviceInfo.device.gatt.connect();
                
                const service = await deviceInfo.device.gatt.getPrimaryService(SERVICE_UUID);
                deviceInfo.writeCharacteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
                deviceInfo.readCharacteristic = await service.getCharacteristic(READ_CHARACTERISTIC_UUID);
                
                await deviceInfo.readCharacteristic.startNotifications();
                deviceInfo.readCharacteristic.addEventListener('characteristicvaluechanged', 
                    (event) => handleNotification(event, side));
                
                if (heartbeatIntervals[side]) {
                    clearInterval(heartbeatIntervals[side]);
                }
                heartbeatIntervals[side] = setInterval(async () => {
                    await sendHeartbeat(deviceInfo, side);
                }, HEARTBEAT_INTERVAL);
                
                console.log(`Successfully reconnected ${side} device`);
                document.getElementById('sendTextButton').disabled = false;
                return true;
            }
            return true;
        } catch (error) {
            console.log(`Reconnection attempt ${attempts + 1} failed: ${error}`);
            attempts++;
            if (attempts < MAX_RECONNECT_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
            }
        }
    }
    console.log(`Failed to reconnect ${side} device after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return false;
}

function setupDeviceListeners(device, side) {
    device.addEventListener('gattserverdisconnected', (event) => {
        console.log(`[${new Date().toISOString()}] ${side} GATT Server disconnected`, event);
    });

    // added all events to listen for just incase

    const characteristicEvents = [
        'characteristicvaluechanged',
        'serviceadded',
        'servicechanged',
        'serviceremoved',
        'characteristicadded',
        'characteristicchanged',
        'characteristicremoved'
    ];

    const bluetoothEvents = [
        'availabilitychanged',
        'connecting',
        'connected',
        'disconnecting',
        'disconnected',
        'advertisementreceived'
    ];

    characteristicEvents.forEach(eventName => {
        device.addEventListener(eventName, (event) => {
            console.log(`[${new Date().toISOString()}] ${side} ${eventName} event:`, event);
            if (event.target && event.target.value) {
                const data = new Uint8Array(event.target.value.buffer);
                console.log(`Data received:`, Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }
        });
    });

    bluetoothEvents.forEach(eventName => {
        device.addEventListener(eventName, (event) => {
            console.log(`[${new Date().toISOString()}] ${side} Bluetooth ${eventName} event:`, event);
        });
    });
}

let deviceCount = 0;  

async function scanAndConnect() {
    try {
        deviceCount = 0;  
        updateStatus('Starting scan...');
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: leftDevice ? RIGHT_PREFIX : LEFT_PREFIX }
            ],
            optionalServices: [SERVICE_UUID],
            acceptAllDevices: false
        });

        const side = leftDevice ? 'right' : 'left';
        updateStatus(`Found ${side} device. Waiting to connect...`);
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        setupDeviceListeners(device, side);
        
        console.log(`Attempting to connect to ${side} device...`);
        const server = await device.gatt.connect();
        console.log(`GATT server connected for ${side} device`);
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const service = await server.getPrimaryService(SERVICE_UUID);
        const writeCharacteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
        const readCharacteristic = await service.getCharacteristic(READ_CHARACTERISTIC_UUID);
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Setting up notifications for ${side}...`);
        await readCharacteristic.startNotifications();
        readCharacteristic.addEventListener('characteristicvaluechanged', 
            (event) => handleNotification(event, side));

        const deviceInfo = { 
            device, 
            writeCharacteristic,
            readCharacteristic 
        };

        if (heartbeatIntervals[side]) {
            clearInterval(heartbeatIntervals[side]);
        }

        heartbeatIntervals[side] = setInterval(async () => {
            await sendHeartbeat(deviceInfo, side);
        }, HEARTBEAT_INTERVAL);
        
        deviceCount++;
        updateStatus(`${side} device connected. ${deviceCount}/2 devices connected.`);
        
        // If we've connected both devices, stop scanning
        if (deviceCount >= 2) {
            updateStatus('Both devices connected successfully!');
            document.getElementById('scanButton').disabled = true;
            document.getElementById('sendTextButton').disabled = false;
        }
        
        return deviceInfo;
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
            
            await deviceInfo.writeCharacteristic.writeValue(data);
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

document.getElementById('scanButton').outerHTML = `
    <button id="scanLeftButton">Connect Left</button>
    <button id="scanRightButton" disabled>Connect Right</button>
`;

document.getElementById('scanLeftButton').addEventListener('click', async () => {
    try {
        document.getElementById('scanLeftButton').disabled = true;
        updateStatus('Preparing to scan for left device...');
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        updateStatus('Scanning for left device...');
        const left = await scanAndConnect();
        leftDevice = left;
        
        document.getElementById('scanRightButton').disabled = false;
        updateStatus('Left device connected. Please click "Connect Right" to connect right device.');
    } catch (error) {
        updateStatus('Error connecting left device: ' + error);
        document.getElementById('scanLeftButton').disabled = false;
    }
});

document.getElementById('scanRightButton').addEventListener('click', async () => {
    try {
        document.getElementById('scanRightButton').disabled = true;
        updateStatus('Preparing to scan for right device...');
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        updateStatus('Scanning for right device...');
        const right = await scanAndConnect();
        rightDevice = right;
        
        document.getElementById('sendTextButton').disabled = false;
        updateStatus('Both devices connected and ready');
    } catch (error) {
        updateStatus('Error connecting right device: ' + error);
        document.getElementById('scanRightButton').disabled = false;
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

        Object.keys(heartbeatIntervals).forEach(side => {
            if (heartbeatIntervals[side]) {
                clearInterval(heartbeatIntervals[side]);
                heartbeatIntervals[side] = null;
            }
        });
        
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

async function sendBmpToDevice(deviceInfo, bmpData, isLeft) {
    try {
        await ensureConnected(deviceInfo.device);
        
        const dataForCrc = new Uint8Array(BMP_ADDRESS.length + bmpData.length);
        dataForCrc.set(BMP_ADDRESS, 0);
        dataForCrc.set(bmpData, BMP_ADDRESS.length);
        
        let seq = 0;
        let offset = 0;
        
        while (offset < bmpData.length) {
            const chunk = bmpData.slice(offset, offset + BMP_PACKET_SIZE);
            const isFirstPacket = offset === 0;
            
            const packet = new Uint8Array([
                BMP_DATA_COMMAND,
                seq,
                ...(isFirstPacket ? BMP_ADDRESS : []),
                ...chunk
            ]);
            
            await deviceInfo.writeCharacteristic.writeValue(packet);
            updateStatus(`Sent BMP packet ${seq + 1} to ${isLeft ? 'left' : 'right'} device`);
            
            seq = (seq + 1) % 256;
            offset += BMP_PACKET_SIZE;
            
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        const crc = crc32(dataForCrc);
        const crcPacket = new Uint8Array([
            BMP_CRC_COMMAND,
            ...crc
        ]);
        await deviceInfo.writeCharacteristic.writeValue(crcPacket);
        updateStatus(`Sent CRC check to ${isLeft ? 'left' : 'right'} device`);
        
        const endPacket = new Uint8Array([BMP_END_COMMAND, 0x0d, 0x0e]);
        await deviceInfo.writeCharacteristic.writeValue(endPacket);
        
        updateStatus(`BMP sent successfully to ${isLeft ? 'left' : 'right'} device`);
    } catch (error) {
        updateStatus(`Error sending BMP to ${isLeft ? 'left' : 'right'} device: ${error}`);
        throw error;
    }
}

async function handleBmpFiles() {
    const leftFile = document.getElementById('leftBmpInput').files[0];
    const rightFile = document.getElementById('rightBmpInput').files[0];
    
    if (!leftFile || !rightFile) {
        updateStatus('Please select both BMP files');
        return;
    }
    
    try {
        const leftData = new Uint8Array(await leftFile.arrayBuffer());
        const rightData = new Uint8Array(await rightFile.arrayBuffer());
        
        if (leftDevice) {
            await sendBmpToDevice(leftDevice, leftData, true);
        }
        if (rightDevice) {
            await sendBmpToDevice(rightDevice, rightData, false);
        }
        
        updateStatus('BMPs sent successfully to both devices');
    } catch (error) {
        updateStatus('Error sending BMPs: ' + error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const leftBmpInput = document.getElementById('leftBmpInput');
    const rightBmpInput = document.getElementById('rightBmpInput');
    const sendBmpButton = document.getElementById('sendBmpButton');
    
    function checkFiles() {
        sendBmpButton.disabled = !(leftBmpInput.files[0] && rightBmpInput.files[0] && leftDevice && rightDevice);
    }
    
    leftBmpInput.addEventListener('change', checkFiles);
    rightBmpInput.addEventListener('change', checkFiles);
    
    sendBmpButton.addEventListener('click', handleBmpFiles);
});

async function testNotifications(deviceInfo, side) {
    try {
        console.log(`Testing notifications for ${side} device...`);
        const isNotifying = await deviceInfo.readCharacteristic.startNotifications();
        console.log(`Notifications ${isNotifying ? 'are' : 'are not'} active for ${side} device`);
    } catch (error) {
        console.log(`Error testing notifications for ${side} device: ${error}`);
    }
}

function handleNotification(event, side) {
    const data = new Uint8Array(event.target.value.buffer);
    const hexData = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const asciiData = Array.from(data).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
    
    console.log(`[${new Date().toISOString()}] Raw data from ${side}:`);
    console.log(`  Hex: ${hexData}`);
    console.log(`  ASCII: ${asciiData}`);
    console.log(`  Decimal: ${Array.from(data)}`);
    console.log(`  First byte: 0x${data[0].toString(16).padStart(2, '0')}`);
    
    let interpretation = "Unknown packet type";
    if (data[0] === HEARTBEAT_COMMAND) {
        interpretation = `Heartbeat response (seq: ${data[3]})`;
    } else if (data[0] === 0xf5) {
        interpretation = `Status update (type: 0x${data[1].toString(16).padStart(2, '0')})`;
    }
    
    console.log(`  Interpretation: ${interpretation}`);
    console.log('------------------------');
}


