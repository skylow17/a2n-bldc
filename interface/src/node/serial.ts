/**
 * Transport série, sur `node-serialport`.
 *
 * Vit dans `src/node/` et non dans `src/shared/` : `shared/` doit rester utilisable sans
 * Node — le simulateur, les tests et à terme le renderer en dépendent. La frontière est donc
 * l'interface `Transport`, et rien d'autre.
 *
 * La carte est en USB CDC : le débit annoncé n'a aucun effet, l'USB ne transporte pas de
 * baud rate. On en déclare un parce que l'API l'exige.
 */

import { SerialPort } from 'serialport';

import { Emitter, type Transport } from '../shared/transport.js';

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
}

/** Identifiants USB de la carte, déclarés dans `USB_Device/App/usbd_desc.c`. */
export const A2N_USB_VID = '0483'; // STMicroelectronics
export const A2N_USB_PID = '5740'; // CDC ACM

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    ...(p.manufacturer !== undefined && { manufacturer: p.manufacturer }),
    ...(p.vendorId !== undefined && { vendorId: p.vendorId }),
    ...(p.productId !== undefined && { productId: p.productId }),
    ...(p.serialNumber !== undefined && { serialNumber: p.serialNumber }),
  }));
}

/** Ports qui ressemblent à la carte, d'après les identifiants USB. */
export async function findBoardPorts(): Promise<SerialPortInfo[]> {
  const ports = await listSerialPorts();
  return ports.filter(
    (p) =>
      p.vendorId?.toLowerCase() === A2N_USB_VID &&
      p.productId?.toLowerCase() === A2N_USB_PID,
  );
}

export class SerialTransport implements Transport {
  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly errorEmitter = new Emitter<Error>();

  private constructor(
    private readonly port: SerialPort,
    readonly description: string,
  ) {
    port.on('data', (chunk: Buffer) => {
      this.dataEmitter.emit(new Uint8Array(chunk));
    });
    port.on('error', (e: Error) => {
      this.errorEmitter.emit(e);
    });
    port.on('close', () => {
      // Débranchement à chaud : sans cet événement, tout ce qui attend une réponse resterait
      // suspendu jusqu'au timeout et l'interface paraîtrait figée.
      this.errorEmitter.emit(new Error(`${description} : port fermé`));
    });
  }

  static async open(path: string, baudRate = 115200): Promise<SerialTransport> {
    const port = await new Promise<SerialPort>((resolve, reject) => {
      const p = new SerialPort({ path, baudRate, autoOpen: false });
      p.open((err) => (err ? reject(err) : resolve(p)));
    });
    return new SerialTransport(port, path);
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  async write(data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
    });
    // On force l'écoulement : sans cela, une petite trame peut stagner dans le tampon du
    // pilote, et le délai d'attente de la réponse expire sans que rien ne soit parti.
    await new Promise<void>((resolve, reject) => {
      this.port.drain((err) => (err ? reject(err) : resolve()));
    });
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    return this.dataEmitter.on(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return this.errorEmitter.on(listener);
  }

  async close(): Promise<void> {
    if (!this.port.isOpen) return;
    await new Promise<void>((resolve) => {
      this.port.close(() => resolve());
    });
  }
}
