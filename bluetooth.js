let leftDevice = null;
let rightDevice = null;
const TEXT_COMMAND = 0x4E;
const SCREEN_STATUS = 0x71;  // 0x70 (Text Show) | 0x01 (Display new content)


const SERVICE_UUID =  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
const WRITE_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
const READ_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

const LEFT_PREFIX = "Even G1_67_L";
const RIGHT_PREFIX = "Even G1_67_R";

const BMP_DATA_COMMAND = 0x15;
const BMP_END_COMMAND = 0x20;
const BMP_CRC_COMMAND = 0x16;
const BMP_ADDRESS = [0x00, 0x1c, 0x00, 0x00];
const BMP_PACKET_SIZE = 194;

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

async function scanAndConnect() {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: leftDevice ? RIGHT_PREFIX : LEFT_PREFIX }
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
            
            await deviceInfo.characteristic.writeValue(packet);
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
        await deviceInfo.characteristic.writeValue(crcPacket);
        updateStatus(`Sent CRC check to ${isLeft ? 'left' : 'right'} device`);
        
        const endPacket = new Uint8Array([BMP_END_COMMAND, 0x0d, 0x0e]);
        await deviceInfo.characteristic.writeValue(endPacket);
        
        updateStatus(`BMP sent successfully to ${isLeft ? 'left' : 'right'} device`);
    } catch (error) {
        updateStatus(`Error sending BMP to ${isLeft ? 'left' : 'right'} device: ${error}`);
        throw error;
    }
}

// Add function to handle file inputs
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