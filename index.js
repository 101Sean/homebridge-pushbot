const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    SCAN_DURATION_MS: 4000,
    CONNECT_TIMEOUT_MS: 7000,
    GATT_TIMEOUT_MS: 10000,
    DISCONNECT_TIMEOUT_MS: 2000,
    GATT_WAIT_MS: 2000,
    WRITE_RETRY_COUNT: 3,
    WRITE_DELAY_MS: 500,
    AUTO_OFF_MS: 1500,
    AUTH_WAIT_MS: 1000,
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
            if (!deviceConfig.mac_address ||
                !deviceConfig.service_uuid ||
                !deviceConfig.write_uuid ||
                !deviceConfig.notify_uuid ||
                !deviceConfig.push_packet_base64) {
                this.log.error(`[Config] "${deviceConfig.name || '이름없음'}" 필수 항목 누락`);
                continue;
            }

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
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.writeUuid = (config.write_uuid || '').toLowerCase();
        this.notifyUuid = (config.notify_uuid || '').toLowerCase();
        this.pushCommand = Buffer.from(config.push_packet_base64, 'base64');
        this.useAuth = config.use_auth === true;   // 인증 패킷 사용 여부
        this.authPacket = Buffer.from([0x66, 0x39]);

        this.isSwitchOn = false;
        this.adapter = null;
        this.device = null;
        this.connectionLock = false;   // 중복 실행 방지

        this.initService();
        this.initNodeBle();
    }

    initService() {
        const { Service, Characteristic } = this.platform;

        this.switchService = this.accessory.getService(Service.Switch) || this.accessory.addService(Service.Switch, this.name);
        this.infoService = this.accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'SwitchBot')
            .setCharacteristic(Characteristic.Model, 'Push Mini')
            .setCharacteristic(Characteristic.SerialNumber, this.macAddress);

        this.switchService.getCharacteristic(Characteristic.On)
            .onSet(this.handleSetOn.bind(this))
            .onGet(() => this.isSwitchOn);
    }

    async initNodeBle() {
        try {
            const { bluetooth } = NodeBle.createBluetooth();
            this.adapter = await bluetooth.defaultAdapter();
            this.log.info(`[${this.name}] BLE 어댑터 준비 완료`);
        } catch (e) {
            this.log.error(`[BLE] 초기화 실패: ${e.message}`);
        }
    }

    async withTimeout(promise, ms, name) {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${name} (${ms}ms)`)), ms)
        );
        return Promise.race([promise, timeout]);
    }

    async findAndConnect() {
        try {
            await this.adapter.stopDiscovery().catch(() => {});
            await this.adapter.startDiscovery({
                uuids: [this.serviceUuid.replace(/-/g, '')]
            });
            await sleep(CONFIG.SCAN_DURATION_MS);
            await this.adapter.stopDiscovery();

            const devices = await this.adapter.devices();
            for (const addr of devices) {
                if (addr.toUpperCase().replace(/:/g, '') === this.macAddress.toUpperCase()) {
                    this.device = await this.adapter.getDevice(addr);
                    await this.withTimeout(this.device.connect(), CONFIG.CONNECT_TIMEOUT_MS, 'Device Connect');
                    this.log.info(`[${this.name}] 연결 성공`);
                    return true;
                }
            }
            this.log.warn(`[${this.name}] 기기를 찾지 못함`);
            return false;
        } catch (e) {
            this.log.error(`[${this.name}] 연결 오류: ${e.message}`);
            return false;
        }
    }

    async disconnectDevice() {
        if (this.device) {
            try {
                await this.withTimeout(this.device.disconnect(), CONFIG.DISCONNECT_TIMEOUT_MS, 'Disconnect');
            } catch (e) {}
            this.device = null;
        }
    }

    async handleSetOn(value) {
        if (!value) return;
        if (this.connectionLock) {
            this.log.warn(`[${this.name}] 이미 명령 처리 중`);
            return;
        }
        this.connectionLock = true;
        const { Characteristic } = this.platform;

        try {
            const ok = await this.findAndConnect();
            if (!ok) throw new Error('연결 실패');

            const gatt = await this.withTimeout(this.device.gatt(), CONFIG.GATT_TIMEOUT_MS, 'GATT Server');
            await sleep(CONFIG.GATT_WAIT_MS);
            const service = await this.withTimeout(gatt.getPrimaryService(this.serviceUuid), CONFIG.GATT_TIMEOUT_MS, 'Primary Service');
            const writeChar = await service.getCharacteristic(this.writeUuid);
            const notifyChar = await service.getCharacteristic(this.notifyUuid);

            if (this.useAuth) {
                this.log.info(`[${this.name}] 인증 패킷 전송 (0x66 0x39)`);
                await writeChar.writeValue(this.authPacket, { type: 'command' });
                await sleep(CONFIG.AUTH_WAIT_MS);
            }

            await notifyChar.startNotifications().catch(() => {});

            this.log.info(`[${this.name}] 명령 전송`);
            let success = false;
            for (let i = 0; i < CONFIG.WRITE_RETRY_COUNT; i++) {
                try {
                    await writeChar.writeValue(this.pushCommand, { type: 'command' });
                    success = true;
                    break;
                } catch (e) {
                    this.log.warn(`[${this.name}] 쓰기 재시도 (${i+1}/${CONFIG.WRITE_RETRY_COUNT})`);
                    await sleep(CONFIG.WRITE_DELAY_MS);
                }
            }

            if (success) {
                this.log.info(`[${this.name}] 작동 완료`);
                this.isSwitchOn = true;
            } else {
                this.log.error(`[${this.name}] 명령 전송 실패`);
            }
        } catch (e) {
            this.log.error(`[${this.name}] 제어 오류: ${e.message}`);
        } finally {
            this.connectionLock = false;
            setTimeout(() => this.disconnectDevice(), CONFIG.DISCONNECT_TIMEOUT_MS);
        }

        setTimeout(() => {
            this.isSwitchOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
        }, CONFIG.AUTO_OFF_MS);
    }

    getServices() {
        return [this.infoService, this.switchService];
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-pushbot', 'PushBotPlatform', PushBotPlatform);
};