/**
 * Codec du protocole A2N BLDC v2.
 *
 * Aucune dépendance à Electron ni à Node : ce module tourne dans le processus principal,
 * dans la CLI de bring-up et dans les tests, sur les mêmes octets. C'est volontaire — c'est
 * la seule façon d'avoir un unique chemin d'exécution pour l'UI, la CLI, le serveur MCP et
 * le simulateur.
 */

export * from './client.js';
export * from './cobs.js';
export * from './crc16.js';
export * from './frame.js';
export * from './messages.js';
export * from './params.js';
export * from './protocol.js';
export * from './simulator.js';
export * from './transport.js';
