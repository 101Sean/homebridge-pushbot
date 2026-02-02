const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    SCAN_DURATION_MS: 4000,
    RECONNECT_DELAY_MS: 15000,
    CONNECT_TIMEOUT_MS: 10000,
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
            new PushBotAccessory(this.log, deviceConfig, this);
        }
    }
}

class PushBotAccessory {
    constructor(log, config, platform) {
        this.log = log;
        this.config = config;
        this.platform = platform;

        this.name = config.name || 'PushBot';
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid).toLowerCase();
        this.writeUuid = (config.write_uuid).toLowerCase();
        this.pushCommand = Buffer.from(config.push_packet_hex, 'hex');

        this.isConnected = false;
        this.isSwitchOn = false;

        this.initService();
        this.initNodeBle();
    }

    initService() {
        const { Service, Characteristic } = this.platform;

        this.switchService = new Service.Switch(this.name);

        this.infoService = new Service.AccessoryInformation()
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

            this.log.info(`[${this.name}] 연결 완료 및 제어 준비 성공.`);

            this.device.once('disconnect', () => {
                this.log.warn(`[${this.name}] 연결 유실됨.`);
                this.isConnected = false;
                this.writeChar = null;
            });
        } catch (e) {
            this.log.error(`[${this.name}] 연결 실패: ${e.message}`);
            this.isConnected = false;
        }
    }

    async handleSetOn(value) {
        if (value) {
            const { Characteristic } = this.platform;

            if (!this.isConnected || !this.writeChar) {
                this.log.warn(`[${this.name}] 현재 연결되어 있지 않습니다.`);
                setTimeout(() => {
                    this.switchService.updateCharacteristic(Characteristic.On, false);
                }, 500);
                return;
            }

            this.log.info(`[${this.name}] 푸시 명령 전송 시작...`);

            try {
                let success = false;
                for (let i = 0; i < CONFIG.WRITE_RETRY_COUNT; i++) {
                    try {
                        await this.writeChar.writeValue(this.pushCommand, { type: 'command' });
                        success = true;
                        break;
                    } catch (err) {
                        this.log.warn(`[${this.name}] 전송 실패 (${i+1}회), 재시도 중...`);
                        await sleep(500);
                    }
                }

                if (success) {
                    this.log.info(`[${this.name}] 스위치 작동 성공`);
                    this.isSwitchOn = true;
                }
            } catch (e) {
                this.log.error(`[${this.name}] 최종 전송 오류: ${e.message}`);
            }

            setTimeout(() => {
                this.isSwitchOn = false;
                this.switchService.updateCharacteristic(Characteristic.On, false);
            }, CONFIG.AUTO_OFF_MS);
        }
    }

    getServices() {
        return [this.infoService, this.switchService];
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-pushbot', 'PushBotPlatform', PushBotPlatform);
};