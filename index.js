const NodeBle = require('node-ble');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CONFIG = {
    SCAN_DURATION_MS: 4000,
    RECONNECT_DELAY_MS: 20000,
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
                this.log.error(`[Config] 기기 "${deviceConfig.name || '이름없음'}"의 필수 항목(mac_address, service_uuid, write_uuid, notify_uuid, push_packet_base64)이 누락되어 건너뜁니다.`);
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

        // Base64 패킷
        this.pushCommand = Buffer.from(config.push_packet_base64, 'base64');

        // 인증 패킷
        this.authPacket = Buffer.from([0x66, 0x39]);

        this.isConnected = false;
        this.isSwitchOn = false;
        this.abortCount = 0;

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
            this.startScanningLoop();
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

    async startScanningLoop() {
        while (true) {
            if (!this.isConnected) {
                try {
                    this.log.info(`[${this.name}] 주변 기기 스캔 중...`);
                    try { await this.adapter.stopDiscovery(); } catch(e) {}
                    // UUID 필터로 원하는 서비스만 스캔
                    await this.adapter.startDiscovery({
                        uuids: [this.serviceUuid.replace(/-/g, '')]
                    });
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
            await this.withTimeout(this.device.connect(), CONFIG.CONNECT_TIMEOUT_MS, 'Device Connect');
            this.isConnected = true;
            this.log.info(`[${this.name}] 연결 성공`);

            // 기존 disconnect 리스너 제거 후 새로 등록
            this.device.removeAllListeners('disconnect');
            this.device.once('disconnect', () => {
                this.log.warn(`[${this.name}] 연결 유실 감지`);
                this.cleanup();
            });

            await this.discoverCharacteristics();
        } catch (e) {
            if (e.message.includes('le-connection-abort-by-local')) {
                this.abortCount++;
                this.log.warn(`[BLE] 로컬 중단 에러 (${this.abortCount}/3)`);
                if (this.abortCount >= 3) {
                    this.resetBluetoothAdapter();
                    this.abortCount = 0;
                }
            }
            this.cleanup();
        }
    }

    cleanup() {
        this.isConnected = false;
        if (this.device) {
            this.withTimeout(this.device.disconnect(), CONFIG.DISCONNECT_TIMEOUT_MS, 'Disconnect').catch(() => {});
            this.device = null;
        }
    }

    resetBluetoothAdapter() {
        this.log.warn(`[BLE] 블루투스 스택 리셋 시도...`);
        const { exec } = require('child_process');
        exec('sudo hciconfig hci0 down && sleep 1 && sudo hciconfig hci0 up', (error) => {
            if (error) {
                this.log.error(`[BLE] 어댑터 리셋 실패: ${error.message}`);
            } else {
                this.log.info(`[BLE] 블루투스 어댑터 재시작 완료`);
            }
        });
    }

    async discoverCharacteristics() {
        try {
            const gatt = await this.withTimeout(this.device.gatt(), CONFIG.GATT_TIMEOUT_MS, 'GATT Server');
            await sleep(CONFIG.GATT_WAIT_MS);

            const service = await this.withTimeout(
                gatt.getPrimaryService(this.serviceUuid),
                CONFIG.GATT_TIMEOUT_MS,
                'Primary Service'
            );

            this.writeChar = await service.getCharacteristic(this.writeUuid);
            this.notifyChar = await service.getCharacteristic(this.notifyUuid);

            // 인증 패킷 전송
            this.log.info(`[${this.name}] 인증 패킷 전송 (0x66 0x39)`);
            await this.writeRaw(this.writeChar, this.authPacket);
            await sleep(CONFIG.AUTH_WAIT_MS);

            // Notify 리스너 등록 (연결 유지용, heartbeat X)
            this.log.info(`[${this.name}] Notify 리스너 등록`);
            await this.notifyChar.startNotifications();
            this.notifyChar.on('valuechanged', (data) => {
                // 상태 업데이트
            });

            this.log.info(`[${this.name}] 초기화 완료, 명령 대기 중`);
        } catch (e) {
            this.log.error(`[${this.name}] GATT 탐색 오류: ${e.message}`);
            this.isConnected = false;
            if (this.device) await this.device.disconnect().catch(() => {});
        }
    }

    async writeRaw(characteristic, packet) {
        if (!this.isConnected || !characteristic) return false;
        for (let i = 0; i < CONFIG.WRITE_RETRY_COUNT; i++) {
            try {
                await characteristic.writeValue(packet, { type: 'command' });
                return true;
            } catch (e) {
                this.log.warn(`[${this.name}] 쓰기 실패 (${i+1}/${CONFIG.WRITE_RETRY_COUNT}) - ${e.message}`);
                await sleep(CONFIG.WRITE_DELAY_MS);
            }
        }
        return false;
    }

    async handleSetOn(value) {
        if (!value) return;

        const { Characteristic } = this.platform;

        try {
            if (!this.isConnected || !this.writeChar) {
                this.log.info(`[${this.name}] 연결 없음 → 즉시 재연결 시도`);
                await this.connectDevice();
            }

            this.log.info(`[${this.name}] 명령 전송`);
            const success = await this.writeRaw(this.writeChar, this.pushCommand);
            if (success) {
                this.log.info(`[${this.name}] 작동 완료`);
                this.isSwitchOn = true;
            }
        } catch (e) {
            this.log.error(`[${this.name}] 제어 오류: ${e.message}`);
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