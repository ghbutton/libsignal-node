
const SessionRecord = require('./session_record.js');
const BaseKeyType = require('./base_key_type.js');
const ChainType = require('./chain_type.js');
const crypto = require('./crypto.js');


function assert_buffer(value) {
    if (!Buffer.isBuffer(value)) {
        debugger;
        throw new TypeError(`Buffer type expected, not ` +
                            `(${value.constructor.name})`);
    }
}


class SessionBuilder {

    constructor(storage, remoteAddress) {
        this.remoteAddress = remoteAddress;
        this.storage = storage;
        this.ourIdentityKey = this.storage.getLocalIdentityKeyPair();
    }

    async processPreKey(device) {
        const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                             device.identityKey);
        if (!trusted) {
            throw new Error('Identity key changed');
        }
        crypto.Ed25519Verify(device.identityKey, device.signedPreKey.publicKey,
                             device.signedPreKey.signature);
        const baseKey = crypto.createKeyPair();
        const devicePreKey = (device.preKey.publicKey);
        const session = await this.initSession(true, baseKey, undefined, device.identityKey,
                                               devicePreKey, device.signedPreKey.publicKey);
        session.pendingPreKey = {
            preKeyId: device.preKey.keyId,
            signedKeyId: device.signedPreKey.keyId,
            baseKey: baseKey.pubKey
        };
        const address = this.remoteAddress.toString();
        let record = this.storage.loadSession(address);
        if (record === undefined) {
            console.warn("Created new SessionRecord:", address);
            record = new SessionRecord(device.identityKey, device.registrationId);
        } else {
            console.log("Loaded SessionRecord:", address);
        }
        record.archiveCurrentState();
        record.updateSessionState(session, device.registrationId);
        this.storage.storeSession(address, record);
        await this.storage.saveIdentity(this.remoteAddress.getName(),
                                        record.identityKey);
    }

    async processV3(record, message) {
        const trusted = await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                             message.identityKey);
        if (!trusted) {
            var e = new Error('Unknown identity key');
            e.identityKey = message.identityKey;
            throw e;
        }
        const preKeyPair = await this.storage.loadPreKey(message.preKeyId);
        const signedPreKeyPair = await this.storage.loadSignedPreKey(message.signedPreKeyId);
        let session = record.getSessionByBaseKey(message.baseKey);
        if (session) {
          console.log("Duplicate PreKeyMessage for session");
          return;
        }
        session = record.getOpenSession();
        if (signedPreKeyPair === undefined) {
            // Session may or may not be the right one, but if it's not, we
            // can't do anything about it ...fall through and let
            // decryptWhisperMessage handle that case
            if (session !== undefined && session.currentRatchet !== undefined) {
                return;
            } else {
                throw new Error("Missing Signed PreKey for PreKeyWhisperMessage");
            }
        }
        if (session !== undefined) {
            record.archiveCurrentState();
        }
        if (message.preKeyId && !preKeyPair) {
            console.log('Invalid prekey id', message.preKeyId);
        }
        const new_session = await this.initSession(false, preKeyPair, signedPreKeyPair,
                                                   message.identityKey, message.baseKey,
                                                   undefined, message.registrationId);
        // Note that the session is not actually saved until the very
        // end of decryptWhisperMessage ... to ensure that the sender
        // actually holds the private keys for all reported pubkeys
        record.updateSessionState(new_session, message.registrationId);
        await this.storage.saveIdentity(this.remoteAddress.getName(), message.identityKey);
        return message.preKeyId;
    }

    async initSession(isInitiator, ourEphemeralKey, ourSignedKey,
                      theirIdentityPubKey, theirEphemeralPubKey,
                      theirSignedPubKey, registrationId) {
        if (isInitiator) {
            if (ourSignedKey !== undefined) {
                throw new Error("Invalid call to initSession");
            }
            ourSignedKey = ourEphemeralKey;
        } else {
            if (theirSignedPubKey !== undefined) {
                throw new Error("Invalid call to initSession");
            }
            theirSignedPubKey = theirEphemeralPubKey;
        }
        let sharedSecret;
        if (ourEphemeralKey === undefined || theirEphemeralPubKey === undefined) {
            sharedSecret = new Uint8Array(32 * 4);
        } else {
            sharedSecret = new Uint8Array(32 * 5);
        }
        for (var i = 0; i < 32; i++) {
            sharedSecret[i] = 0xff;
        }
        const a1 = crypto.calculateAgreement(theirSignedPubKey, this.ourIdentityKey.privKey);
        const a2 = crypto.calculateAgreement(theirIdentityPubKey, ourSignedKey.privKey);
        const a3 = crypto.calculateAgreement(theirSignedPubKey, ourSignedKey.privKey);
        if (isInitiator) {
            sharedSecret.set(new Uint8Array(a1), 32);
            sharedSecret.set(new Uint8Array(a2), 32 * 2);
        } else {
            sharedSecret.set(new Uint8Array(a1), 32 * 2);
            sharedSecret.set(new Uint8Array(a2), 32);
        }
        sharedSecret.set(new Uint8Array(a3), 32 * 3);
        if (ourEphemeralKey !== undefined && theirEphemeralPubKey !== undefined) {
            const a4 = crypto.calculateAgreement(theirEphemeralPubKey, ourEphemeralKey.privKey);
            sharedSecret.set(new Uint8Array(a4), 32 * 4);
        }
        const masterKey = crypto.HKDF(Buffer.from(sharedSecret), Buffer.alloc(32),
                                      Buffer.from("WhisperText"));
        const session = SessionRecord.createEntry();
        session.registrationId = registrationId;
        session.currentRatchet = {
            rootKey: masterKey[0],
            lastRemoteEphemeralKey: theirSignedPubKey,
            previousCounter: 0
        };
        session.indexInfo = {
            remoteIdentityKey: theirIdentityPubKey,
            closed: -1
        };
        session.oldRatchetList = [];

        // If we're initiating we go ahead and set our first sending ephemeral key now,
        // otherwise we figure it out when we first maybeStepRatchet with the remote's ephemeral key
        if (isInitiator) {
            session.indexInfo.baseKey = ourEphemeralKey.pubKey;
            session.indexInfo.baseKeyType = BaseKeyType.OURS;
            session.currentRatchet.ephemeralKeyPair = crypto.createKeyPair();
            this.calculateSendingRatchet(session, theirSignedPubKey);
            return session;
        } else {
            session.indexInfo.baseKey = theirEphemeralPubKey;
            session.indexInfo.baseKeyType = BaseKeyType.THEIRS;
            session.currentRatchet.ephemeralKeyPair = ourSignedKey;
            return session;
        }
    }

    calculateSendingRatchet(session, remoteKey) {
        var ratchet = session.currentRatchet;
        const sharedSecret = crypto.calculateAgreement(remoteKey,
            ratchet.ephemeralKeyPair.privKey);
        const masterKey = crypto.HKDF(sharedSecret, ratchet.rootKey,
            Buffer.from("WhisperRatchet"));
        session.addChain(ratchet.ephemeralKeyPair.pubKey, {
            messageKeys: {},
            chainKey: {
                counter: -1,
                key: masterKey[1]
            },
            chainType: ChainType.SENDING
        });
        ratchet.rootKey = masterKey[0];
    }
}

module.exports = SessionBuilder;
