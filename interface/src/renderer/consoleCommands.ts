/**
 * Catalogue des commandes de la console ASCII.
 *
 * Le jeu de commandes a beaucoup grossi pendant le bring-up de M2 — pilote de grille,
 * PWM à vide, diagnostics analogiques, capteur de position — et il vivait entièrement dans
 * `docs/protocol.md`. Au banc, ça veut dire lâcher la sonde pour aller chercher la syntaxe
 * d'une commande dans un fichier. D'où cette liste, affichable à côté du champ de saisie.
 *
 * **Pourquoi une liste écrite ici, et pas découverte depuis la carte.** Le dictionnaire de
 * paramètres, lui, vient du firmware et ne se recopie jamais côté PC (`AGENTS.md` §6) : il
 * est auto-décrit, c'est tout l'intérêt. La console ASCII n'a rien de tel — pas de `HELP?`,
 * et lui en ajouter un coûterait plusieurs kilo-octets de chaînes dans une flash qui sert à
 * autre chose. La duplication est donc assumée, mais **pas laissée sans garde-fou** :
 * `__tests__/consoleCommands.test.ts` confronte cette liste au tableau de `docs/protocol.md`
 * dans les deux sens, et échoue si l'une des deux avance sans l'autre. C'est la dérive qui
 * était le vrai risque, pas la duplication.
 *
 * Libellés en anglais (`AGENTS.md` §5) : tout ce qu'un utilisateur lit l'est.
 */

export interface ConsoleCommand {
  /** Le verbe, tel que le firmware l'aiguille — premier mot, casse indifférente. */
  verb: string;
  /** Syntaxe complète, arguments compris, telle qu'on la tape. */
  syntax: string;
  /** Une ligne : ce que ça fait, et si besoin ce qu'il faut en conclure. */
  summary: string;
  /** Met une sortie de puissance sous tension, ou change l'état du pont. */
  arms?: boolean;
}

export interface ConsoleGroup {
  title: string;
  commands: ConsoleCommand[];
}

export const CONSOLE_GROUPS: ConsoleGroup[] = [
  {
    title: 'Link and identity',
    commands: [
      { verb: 'PING', syntax: 'PING [text]', summary: 'Round-trip check; echoes the argument back.' },
      { verb: 'INFO?', syntax: 'INFO?', summary: 'Product, firmware and protocol version, UID, compiled board constants.' },
      { verb: 'PROTO?', syntax: 'PROTO?', summary: 'Protocol version and announced capability bits.' },
      { verb: 'LINK?', syntax: 'LINK?', summary: 'Frames dropped on each direction of the USB link.' },
      { verb: 'STATS?', syntax: 'STATS?', summary: 'Control-loop ticks, last and worst ISR duration, loop load, raw phase currents.' },
      { verb: 'STATS.RESET', syntax: 'STATS.RESET', summary: 'Clears the worst-case ISR duration so a new measurement starts clean.' },
      { verb: 'SELFTEST', syntax: 'SELFTEST', summary: 'Runs the codec self-test on the board and reports the dictionary hash.' },
    ],
  },
  {
    title: 'Safety barrier',
    commands: [
      { verb: 'SAFETY?', syntax: 'SAFETY?', summary: 'Barrier state: cut reason, latched flag, outputs live, time since last command, trip count.' },
      { verb: 'FAULTCLR', syntax: 'FAULTCLR', summary: 'Acknowledges a latched fault. Refuses while the cause is still present.' },
      { verb: 'STOP', syntax: 'STOP', summary: 'Cuts the power outputs immediately.' },
    ],
  },
  {
    title: 'Gate driver',
    commands: [
      { verb: 'DRV?', syntax: 'DRV?', summary: 'DRV8304 status: SPI reachable, nFAULT pin, fault edges counted, seven registers.' },
      { verb: 'DRV.PROBE', syntax: 'DRV.PROBE', summary: 'Writes then reads back a register and restores it. Leaves no trace in the driver.' },
      { verb: 'DRV.REG', syntax: 'DRV.REG <addr> [<value>]', summary: 'Reads a register, or writes it then reads it back. Hexadecimal.' },
      { verb: 'DRV.CAL', syntax: 'DRV.CAL <ON|OFF>', summary: 'Drives the CAL pin, which shorts the shunt amplifier inputs for offset calibration.' },
      { verb: 'DRV.CLR', syntax: 'DRV.CLR', summary: 'Clears latched driver faults over SPI.' },
      { verb: 'DRV.PINS', syntax: 'DRV.PINS', summary: 'Reads the three SPI lines as digital inputs, pulled down then up, plus nCS. Says whether a line is free, held low or held high.' },
      { verb: 'DRV.NCS', syntax: 'DRV.NCS', summary: 'Reads nCS and SDO together as inputs with opposite pulls. Tells a driver that answers its own select apart from two lines that simply touch, which look identical otherwise.' },
      { verb: 'DRV.BITBANG', syntax: 'DRV.BITBANG [<tx_hex>]', summary: 'Drives one 16-bit frame by hand at 10 us per bit, sampling MISO on both clock edges. Says whether the part answers at all, and whether the hardware SPI is half a clock out.' },
      { verb: 'DRV.LOOP', syntax: 'DRV.LOOP [<ms>]', summary: 'Hammers a register read for a few seconds so a scope can trigger on the SPI lines. Counts the transfers that completed and what they returned.' },
    ],
  },
  {
    title: 'Power stage',
    commands: [
      { verb: 'PWM?', syntax: 'PWM?', summary: 'Timer state, duty cycles in per mille, and whether the outputs are enabled.' },
      { verb: 'ARM', syntax: 'ARM', summary: 'Arms the board. Nothing energises the power stage without it; a reset, a fault, a lost host, STOP and PWM OFF disarm.', arms: true },
      { verb: 'DISARM', syntax: 'DISARM', summary: 'Cuts the outputs and disarms.' },
      { verb: 'OL', syntax: 'OL <amp_pm> <elec_hz> <ms> | STOP', summary: 'Open loop: a voltage vector turns at the given electrical frequency, reached by a ramp. At most 57 per mille, 20 Hz and 10 s; needs ARM. STOP ends it without disarming.', arms: true },
      { verb: 'OL?', syntax: 'OL?', summary: 'Open-loop state: target and ramped frequency, electrical angle, time left.' },
      { verb: 'CL', syntax: 'CL <id_ma> <iq_ma> <ms> | STOP', summary: 'Current loop: two PI regulators hold Id and Iq, tuned in firmware from R and L at 500 Hz. At most 300 mA per axis and 10 s, voltage capped like the open loop; needs ARM. Iq makes torque, so the rotor turns. STOP ends it without disarming.', arms: true },
      { verb: 'CL?', syntax: 'CL?', summary: 'Current-loop state: setpoints, mean Id and Iq since the start, last voltage, how often the voltage cap bit, gains.' },
      { verb: 'FOC?', syntax: 'FOC?', summary: 'Rotor-frame current, measurement only: electrical angle from the encoder, Id and Iq in mA. cfg=0 when the motor parameters are implausible or the CORDIC failed its boot self-test.' },
      { verb: 'PWM', syntax: 'PWM ON | OFF | <a> <b> <c>', summary: 'Enables or cuts the outputs, or sets the three duty cycles in per mille (0 to 800, at most 100 apart). Enabling refuses on a latched fault, without a measured current zero, or with no host.', arms: true },
      { verb: 'PWM.PULSE', syntax: 'PWM.PULSE <a> <b> <c> <ms>', summary: 'Step 5 test: applies the duty cycles for 1 to 200 ms, timed by the control loop, then cuts the outputs by itself. Same limits as PWM; an overcurrent cuts it short.', arms: true },
    ],
  },
  {
    title: 'Position sensor',
    commands: [
      { verb: 'ENC?', syntax: 'ENC?', summary: 'AS5600 state and the whole latency budget: magnet, angle, transfer time, sample period, worst sample age, I²C errors.' },
      { verb: 'ENC.REG', syntax: 'ENC.REG <addr> [<len>]', summary: 'Reads 1 to 8 sensor registers. AGC is 0x1A, MAGNITUDE 0x1B, CONF 0x07.' },
      { verb: 'ENC.BUS', syntax: 'ENC.BUS <100000|400000|1000000>', summary: 'Sets the SCL frequency. Default is 1 MHz, measured good on this board.' },
      { verb: 'ENC.RST', syntax: 'ENC.RST', summary: 'Clears the worst sample age and the transfer counters.' },
    ],
  },
  {
    title: 'Analog and current-sense diagnostics',
    commands: [
      { verb: 'SENS.ALL?', syntax: 'SENS.ALL?', summary: 'Every rail, the measured VREF+, junction temperature, and a slow read-back of the three current inputs.' },
      { verb: 'ADC?', syntax: 'ADC?', summary: 'Raw ADC1 registers and the last injected conversion results.' },
      { verb: 'ADC.HOLD', syntax: 'ADC.HOLD <ON|OFF>', summary: 'Freezes the injected conversion group, so a measurement is not disturbed by the control loop.' },
      { verb: 'ADC.PROBE', syntax: 'ADC.PROBE', summary: 'Pulls the three current inputs down then up as digital inputs. A driven source holds its level; a floating node follows the pull.' },
      { verb: 'VREF.SCAN', syntax: 'VREF.SCAN [<gap_us>]', summary: 'Four channels on two converters at a chosen spacing, with dispersion and raw samples.' },
      { verb: 'VREF.RATIO', syntax: 'VREF.RATIO', summary: 'VREFINT and a rail converted back to back. Their ratio cancels VREF+, so it tells whether the rail itself is steady.' },
      { verb: 'VREF.FREQ', syntax: 'VREF.FREQ [<interval_us>]', summary: 'Counts crossings to measure the frequency of whatever moves on the reference.' },
      { verb: 'VREF.BUF', syntax: 'VREF.BUF ON [2048|2500|2900] | OFF', summary: 'Hands VREF+ to the MCU internal buffer. A workaround while the reference oscillates; 2900 is the only scale above the DRV8304 undervoltage threshold.' },
      { verb: 'IMOT?', syntax: 'IMOT?', summary: 'Working offsets of the current chain, the last raw and centred reading, and the gain applied to each channel. Says whether the offsets were measured or only assumed.' },
      { verb: 'NVM?', syntax: 'NVM?', summary: 'Parameter persistence: whether a valid record was found, its sequence and page, and how many entries were restored or skipped at boot.' },
      { verb: 'NVM.SAVE', syntax: 'NVM.SAVE', summary: 'Writes every persistent parameter to flash, then reads the record back. Refused while the power outputs are live.' },
      { verb: 'IMOT.CAL', syntax: 'IMOT.CAL [<n>]', summary: 'Measures the working zero of the current chain, outputs off and CAL left low, and stores it if plausible. Refused while the outputs are live.' },
      { verb: 'IMOT.AMP', syntax: 'IMOT.AMP [<n>]', summary: 'Zero of the amplifiers alone, with the DRV CAL pin raised. Diagnostic only: nothing is stored.' },
      { verb: 'IMOT.NOISE', syntax: 'IMOT.NOISE [<n>]', summary: 'The same measurement as IMOT.CAL without storing anything. Usable with the outputs live, where it measures the current flowing.' },
      { verb: 'IMOT.Z', syntax: 'IMOT.Z', summary: 'Impedance of the three current inputs: each pin forced then released, converted immediately and 2 ms later.' },
      { verb: 'IMOT.DECAY', syntax: 'IMOT.DECAY', summary: 'Charges each input and watches it decay, against PA3 which is a no-connect. Says which side of the chain is broken.' },
      { verb: 'IMOT.WIGGLE', syntax: 'IMOT.WIGGLE <A|B|C> [<ms>]', summary: 'Drives one input as a 1 kHz square wave so a single scope probe on the DRV pin settles continuity.' },
    ],
  },
];

export const CONSOLE_COMMANDS: ConsoleCommand[] = CONSOLE_GROUPS.flatMap((g) => g.commands);

/** Les quelques commandes qu'on tape le plus souvent, proposées sous le champ de saisie. */
export const QUICK_COMMANDS = ['INFO?', 'STATS?', 'SAFETY?', 'SENS.ALL?', 'ENC?', 'DRV?'];

/**
 * Filtre le catalogue. Cherche dans le verbe, la syntaxe et le résumé : au banc on se
 * souvient souvent de ce qu'une commande fait sans se rappeler comment elle s'appelle.
 */
export function searchCommands(query: string): ConsoleGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return CONSOLE_GROUPS;
  return CONSOLE_GROUPS.map((g) => ({
    title: g.title,
    commands: g.commands.filter(
      (c) =>
        c.verb.toLowerCase().includes(q) ||
        c.syntax.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q),
    ),
  })).filter((g) => g.commands.length > 0);
}
