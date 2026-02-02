const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    SCAN_DURATION_MS: 4000,
    RECONNECT_DELAY_MS: 5000,
    HEART_BEAT_INTERVAL_MS: 15000,
    GATT_WAIT_MS: 2000,
    WRITE_RETRY_COUNT: 3,
    AUTO_OFF_MS: 1500,
};

class PushBotPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.api.on('didFinishLaunching', () => {
            this.discoverDevices();
        });
    }

    discoverDevices() {
        if (!this.config.devices || !Array.isArray(this.config.devices)) return;

        for (const deviceConfig of this.config.devices) {
            this.log.info(`기기 등록 중: ${deviceConfig.name}`);

            const uuid = this.api.hap.uuid.generate(deviceConfig.mac_address);
            const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
            new PushBotAccessory(this.log, deviceConfig, this, accessory);
            this.api.registerPlatformAccessories('homebridge-pushbot', 'PushBotPlatform', [accessory]);
        }
    }
}

class PushBotAccessory {
    constructor(log, config, platform, accessory) {
        this.log = log;
        this.config = config;
        this.platform = platform;
        this.accessory = accessory;

        this.name = config.name || 'PushBot';
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid).toLowerCase();
        this.writeUuid = (config.write_uuid).toLowerCase();
        this.notifyUuid = (config.notify_uuid).toLowerCase();
        this.pushCommand = Buffer.from(config.push_packet_hex, 'hex');

        this.isConnected = false;
        this.isSwitchOn = false;
        this.heartbeatTimer = null;

        this.initService();
        this.initNodeBle();
    }

    initService() {
        const { Service, Characteristic } = this.platform;

        this.switchService = this.accessory.getService(Service.Switch) || this.accessory.addService(Service.Switch, this.name);

        this.infoService = this.accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'BLE Bot')
            .setCharacteristic(Characteristic.Model, 'PushBot')
            .setCharacteristic(Characteristic.SerialNumber, this.macAddress);

        this.switchService.getCharacteristic(Characteristic.On)
            .onSet(this.handleSetOn.bind(this))
            .onGet(() => this.isSwitchOn);
    }

    async initNodeBle() {
        try {
            const { bluetooth } = NodeBle.createBluetooth();
            this.adapter = await bluetooth.defaultAdapter();
            this.startScanningLoop();
        } catch (e) {
            this.log.error(`[BLE] 초기화 실패: ${e.message}`);
        }
    }

    async startScanningLoop() {
        while (true) {
            if (!this.isConnected) {
                try {
                    this.log.info(`[${this.name}] 주변 기기 스캔 중...`);
                    try { await this.adapter.stopDiscovery(); } catch(e) {}
                    await this.adapter.startDiscovery();
                    await sleep(CONFIG.SCAN_DURATION_MS);
                    await this.adapter.stopDiscovery();

                    const devices = await this.adapter.devices();
                    for (const addr of devices) {
                        if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                            this.device = await this.adapter.getDevice(addr);
                            await this.connectDevice();
                            break;
                        }
                    }
                } catch (e) {
                    this.log.error(`[BLE] 스캔 에러: ${e.message}`);
                }
            }
            await sleep(CONFIG.RECONNECT_DELAY_MS);
        }
    }

    async connectDevice() {
        try {
            this.log.info(`[${this.name}] 연결 시도...`);
            await this.device.connect();
            this.isConnected = true;

            const gatt = await this.device.gatt();
            await sleep(CONFIG.GATT_WAIT_MS);

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.writeChar = await service.getCharacteristic(this.writeUuid);
            try {
                this.notifyChar = await service.getCharacteristic(this.notifyUuid);
                await this.notifyChar.startNotifications();
                this.startHeartbeat();
                this.log.debug(`[${this.name}] 하트비트 활성화 (간격: ${CONFIG.HEART_BEAT_INTERVAL_MS}ms)`);
            } catch (e) {
                this.log.warn(`[${this.name}] 하트비트 설정 건너뜀`);
            }

            this.log.info(`[${this.name}] 연결 성공 및 준비 완료.`);

            this.device.once('disconnect', () => {
                this.log.warn(`[${this.name}] 연결 유실됨.`);
                this.isConnected = false;
                this.writeChar = null;
                if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            });
        } catch (e) {
            this.isConnected = false;
            throw e;
        }
    }

    async handleSetOn(value) {
        if (!value) return;

        const { Characteristic } = this.platform;

        try {
            if (!this.isConnected || !this.writeChar) {
                this.log.info(`[${this.name}] 연결 없음. 즉시 재연결 시도...`);
                await this.connectDevice();
            }

            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.log.info(`[${this.name}] 명령 전송 준비 중 (Packet: ${this.config.push_packet_hex})`);
            await sleep(300);

            let success = false;
            for (let i = 0; i < CONFIG.WRITE_RETRY_COUNT; i++) {
                try {
                    await this.writeChar.writeValue(this.pushCommand, { type: 'request' });
                    success = true;
                    break;
                } catch (err) {
                    this.log.warn(`[${this.name}] 전송 실패 재시도 (${i+1}): ${err.message}`);
                    await sleep(500);
                }
            }

            if (success) {
                this.log.info(`[${this.name}] 작동 명령 전송 완료.`);
                this.isSwitchOn = true;
            }

            this.startHeartbeat();
        } catch (e) {
            this.log.error(`[${this.name}] 제어 실패: ${e.message}`);
        }

        setTimeout(() => {
            this.isSwitchOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
        }, CONFIG.AUTO_OFF_MS);
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(async () => {
            if (this.isConnected && this.notifyChar) {
                try {
                    await this.notifyChar.readValue();
                } catch (e) {}
            }
        }, CONFIG.HEART_BEAT_INTERVAL_MS);
    }

    getServices() {
        return [this.infoService, this.switchService];
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-pushbot', 'PushBotPlatform', PushBotPlatform);
};