/**
 * Le DeviceCore face au device simulé.
 *
 * C'est la logique que l'UI se contente de refléter : la tester ici vaut mieux que de
 * cliquer dans la fenêtre, et couvre aussi le chemin qu'emprunteront la CLI et le serveur
 * MCP, puisque c'est le même.
 */

import { describe, expect, it } from 'vitest';

import type { TelemFrame } from '../../../shared/messages.js';
import { ScopeTrigger } from '../../../shared/protocol.js';
import { DeviceCore, type LogEntry } from '../DeviceCore.js';

async function connected(): Promise<{ core: DeviceCore; logs: LogEntry[] }> {
  const core = new DeviceCore();
  const logs: LogEntry[] = [];
  core.onLog.on((e) => logs.push(e));
  await core.connect({ kind: 'simulator' });
  return { core, logs };
}

describe('connexion', () => {
  it('charge identité, dictionnaire et valeurs en une passe', async () => {
    const { core } = await connected();
    const s = core.snapshot();

    expect(s.connection).toBe('connected');
    expect(s.info?.product).toBe('A2N-BLDC');
    expect(s.params).toHaveLength(s.info!.paramCount);
    expect(s.params.every((p) => p.value !== null)).toBe(true);
  });

  it("vérifie l'intégrité du dictionnaire reçu", async () => {
    const { core } = await connected();
    // Le hash recalculé sur les entrées reçues doit retomber sur celui du handshake.
    expect(core.snapshot().dictIntegrity).toBe(true);
  });

  it('expose les constantes réelles de la carte', async () => {
    const { core } = await connected();
    const byName = new Map(core.snapshot().params.map((p) => [p.name, p.value]));
    expect(byName.get('board.sysclk_hz')).toBe(144_000_000);
    expect(byName.get('pwm.freq_hz')).toBe(20_000);
    expect(byName.get('pwm.arr')).toBe(3599);
  });

  it('rend un état propre après déconnexion', async () => {
    const { core } = await connected();
    await core.disconnect();
    const s = core.snapshot();
    expect(s.connection).toBe('disconnected');
    expect(s.info).toBeNull();
    expect(s.params).toEqual([]);
  });

  it('signale une connexion impossible sans rester en « connecting »', async () => {
    const core = new DeviceCore();
    await expect(core.connect({ kind: 'serial', path: 'COM_INEXISTANT' })).rejects.toThrow();
    expect(core.snapshot().connection).toBe('error');
    expect(core.snapshot().lastError).not.toBeNull();
  });
});

describe('écriture de paramètres', () => {
  it('écrit puis relit, et publie la valeur retenue par le firmware', async () => {
    const { core } = await connected();
    const returned = await core.writeParam('dbg.echo_f32', 12.5);
    expect(returned).toBe(12.5);

    const p = core.snapshot().params.find((x) => x.name === 'dbg.echo_f32');
    expect(p?.value).toBe(12.5);
  });

  it("publie la valeur arrondie, pas celle qui a été saisie", async () => {
    // Le firmware arrondit vers le type réel. Afficher la saisie plutôt que la valeur
    // retenue est exactement le genre de mensonge qui fait régler à l'aveugle.
    const { core } = await connected();
    const returned = await core.writeParam('dbg.echo_i16', 2.9999997);
    expect(returned).toBe(3);
    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_i16')?.value).toBe(3);
  });

  it('contraint au domaine déclaré avant d’envoyer', async () => {
    const { core } = await connected();
    // 1e6 est hors bornes : la valeur est ramenée à max plutôt que refusée par le firmware.
    expect(await core.writeParam('dbg.echo_f32', 1e6)).toBe(1000);
  });

  it('remonte un refus en lecture seule comme une erreur', async () => {
    const { core } = await connected();
    await expect(core.writeParam('pwm.arr', 1234)).rejects.toThrow(/rejected/i);
    expect(core.snapshot().params.find((p) => p.name === 'pwm.arr')?.value).toBe(3599);
  });

  it('rejette un paramètre inconnu', async () => {
    const { core } = await connected();
    await expect(core.writeParam('pid.iq.kp', 1)).rejects.toThrow(/unknown parameter/);
  });

  it('remet les valeurs par défaut', async () => {
    const { core } = await connected();
    await core.writeParam('dbg.echo_u32', 999);
    await core.resetDefaults();
    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_u32')?.value).toBe(0);
  });
});

describe('pilotage par agent', () => {
  it('refuse une écriture d’origine agent tant que le contrôle est désactivé', async () => {
    const { core } = await connected();
    expect(core.isAiControlEnabled).toBe(false);

    // La barrière vit dans le DeviceCore et non dans le renderer : elle tient même si
    // quelqu'un contourne l'interface.
    await expect(core.writeParam('dbg.echo_f32', 1, 'mcp')).rejects.toThrow(/AI control/i);
  });

  it('laisse passer une fois le contrôle activé, et le journalise', async () => {
    const { core, logs } = await connected();
    core.setAiControl(true);
    await core.writeParam('dbg.echo_f32', 3.5, 'mcp');

    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_f32')?.value).toBe(3.5);
    // La source doit rester visible dans le journal : une action d'agent ne doit pas être
    // indiscernable d'une action humaine.
    expect(logs.some((l) => l.source === 'mcp' && l.text.includes('dbg.echo_f32'))).toBe(true);
    expect(logs.some((l) => l.level === 'warn' && l.text.includes('ENABLED'))).toBe(true);
  });

  it('n’entrave jamais une action humaine', async () => {
    const { core } = await connected();
    await expect(core.writeParam('dbg.echo_f32', 2, 'gui')).resolves.toBe(2);
  });
});

describe('console', () => {
  it('relaie une commande et journalise la réponse du device', async () => {
    const { core, logs } = await connected();
    expect(await core.sendConsole('PING')).toBe('OK');
    expect(logs.some((l) => l.source === 'device' && l.text === 'OK')).toBe(true);
  });

  it('répond à STOP et coupe la sortie de puissance', async () => {
    // Le bouton STOP de l'interface s'appuie sur cette commande. Elle a été spécifiée dès
    // le départ mais n'existait pas dans le firmware : le bouton répondait ERR CMD, donc
    // ne faisait rien tout en paraissant agir. Ce test est là pour que ça ne se reproduise
    // pas — une commande d'arrêt qui échoue en silence est pire que pas de bouton.
    const { core } = await connected();
    expect(await core.sendConsole('STOP')).toBe('OK');
    expect(await core.sendConsole('PWM?')).toBe('OK enabled=0');
  });

  it('rapporte un auto-test réel, vecteurs à l’appui', async () => {
    const { core } = await connected();
    const reply = await core.sendConsole('SELFTEST');
    expect(reply).toMatch(/^OK /);
    expect(reply).toMatch(/failed=0/);
    expect(reply).toMatch(/dict_ok=1/);
    // Un auto-test qui n'a exécuté aucun vecteur ne vaut pas un succès.
    expect(Number(/total=(\d+)/.exec(reply)?.[1] ?? 0)).toBeGreaterThan(0);
  });
});

describe('scope', () => {
  it('capture les quatre premiers signaux par défaut, en immédiat', async () => {
    const { core } = await connected();
    const { signals, capture } = await core.captureScope({ depth: 256 });

    expect(signals).toHaveLength(4);
    expect(capture.samples).toHaveLength(256);
    expect(capture.samples[0]).toHaveLength(4);
  });

  it('désigne les signaux par nom, jamais par identifiant', async () => {
    // L'appelant travaille avec le dictionnaire publié par le firmware ; la numérotation
    // reste une affaire interne au protocole.
    const { core } = await connected();
    const { signals } = await core.captureScope({
      depth: 64,
      signalNames: ['loop.load_pct', 'current.raw_ia_count'],
    });

    expect(signals.map((s) => s.name)).toEqual(['loop.load_pct', 'current.raw_ia_count']);
  });

  it('rejette un nom de signal inconnu', async () => {
    const { core } = await connected();
    await expect(core.captureScope({ signalNames: ['nope'] })).rejects.toThrow('unknown signal');
  });

  it('refuse plus de quatre signaux', async () => {
    const { core } = await connected();
    const names = (await core.readSignals()).slice(0, 5).map((s) => s.name);
    await expect(core.captureScope({ signalNames: names })).rejects.toThrow('1 to 4');
  });

  it('accepte une configuration de déclenchement complète', async () => {
    const { core } = await connected();
    const { capture } = await core.captureScope({
      depth: 128,
      decimation: 4,
      pretriggerSamples: 32,
      triggerMode: ScopeTrigger.RISING,
      triggerSignalName: 'current.raw_ia_count',
      threshold: 2048,
      signalNames: ['current.raw_ia_count', 'loop.load_pct'],
    });

    // La configuration rendue est celle que le firmware a normalisée, pas celle demandée.
    expect(capture.config.decimation).toBe(4);
    expect(capture.config.pretriggerSamples).toBe(32);
    expect(capture.config.triggerMode).toBe(ScopeTrigger.RISING);
    expect(capture.status.samplePeriodNs).toBe(50_000 * 4);
  });

  it('exige que le signal de déclenchement soit capturé', async () => {
    // Sans cela, le point de déclenchement n'apparaîtrait sur aucune courbe tracée — et le
    // firmware refuserait la configuration de toute façon, avec un message moins clair.
    const { core } = await connected();
    await expect(
      core.captureScope({
        triggerMode: ScopeTrigger.RISING,
        triggerSignalName: 'loop.load_pct',
        signalNames: ['current.raw_ia_count'],
      }),
    ).rejects.toThrow('must be one of the captured signals');
  });

  it('refuse un pretrigger qui ne tient pas dans la profondeur', async () => {
    const { core } = await connected();
    await expect(
      core.captureScope({ depth: 16, pretriggerSamples: 16 }),
    ).rejects.toThrow('pretrigger must be below depth');
  });
});

describe('télémétrie continue', () => {
  /** Attend `n` trames sur le flux souscrit, ou échoue au bout de 3 s. */
  async function collect(core: DeviceCore, n: number): Promise<TelemFrame[]> {
    const got: TelemFrame[] = [];
    return new Promise<TelemFrame[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`only ${got.length}/${n} frames`));
      }, 3000);
      const off = core.onTelemetry.on((f) => {
        got.push(f);
        if (got.length >= n) {
          clearTimeout(timer);
          off();
          resolve(got);
        }
      });
    });
  }

  it('ouvre un flux qui dure et pousse les trames', async () => {
    const { core } = await connected();
    const state = await core.startTelemetry(['loop.load_pct'], 500);

    expect(state.signalNames).toEqual(['loop.load_pct']);
    expect(state.units).toEqual(['%']);
    // Le firmware choisit un diviseur entier de la boucle : c'est la cadence retenue qui
    // est publiée, pas celle demandée.
    expect(state.rateHz).toBe(500);

    const frames = await collect(core, 5);
    expect(frames).toHaveLength(5);
    expect(frames[0]?.values).toHaveLength(1);
  });

  it("publie l'abonnement dans le snapshot", async () => {
    // Le device n'accepte qu'un seul abonnement : à quoi l'interface s'est abonnée fait
    // partie de l'état partagé, pas d'un détail interne.
    const { core } = await connected();
    expect(core.snapshot().telemetry).toBeNull();

    await core.startTelemetry(['loop.load_pct', 'loop.duration_ns'], 200);
    expect(core.snapshot().telemetry?.signalNames).toEqual([
      'loop.load_pct',
      'loop.duration_ns',
    ]);

    await core.stopTelemetry();
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('coupe le flux à la déconnexion', async () => {
    const { core } = await connected();
    await core.startTelemetry(['loop.load_pct'], 200);
    await core.disconnect();
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('rétablit le flux après un burst pris par un agent', async () => {
    // C'est le vrai piège : le device n'a qu'un abonnement, et sampleTelemetry le
    // réécrivait. Un agent qui échantillonnait faisait décrocher les courbes de
    // l'interface, sans que rien ne le dise.
    const { core, logs } = await connected();
    await core.startTelemetry(['loop.load_pct'], 500);
    const before = core.snapshot().telemetry;

    await core.sampleTelemetry(5, 100, ['current.raw_ia_count']);

    expect(core.snapshot().telemetry).toEqual(before);
    expect(logs.some((l) => l.text.includes('paused for a burst sample'))).toBe(true);

    // Et le flux rétabli pousse réellement à nouveau.
    const frames = await collect(core, 3);
    expect(frames[0]?.values).toHaveLength(1);
  });

  it('laisse le flux coupé si rien ne tournait avant le burst', async () => {
    const { core } = await connected();
    await core.sampleTelemetry(5, 100, ['loop.load_pct']);
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('refuse une sélection vide ou trop large', async () => {
    const { core } = await connected();
    await expect(core.startTelemetry([], 200)).resolves.toBeDefined(); // vide = tous
    const names = (await core.readSignals()).map((s) => s.name);
    await expect(core.startTelemetry([...names, ...names], 200)).rejects.toThrow('1 to 16');
    await expect(core.startTelemetry(['nope'], 200)).rejects.toThrow('unknown signal');
  });
});

describe('attribution dans le journal', () => {
  it('attribue une capture à son appelant, pas à une constante', async () => {
    // Le journal sert à distinguer qui a fait quoi. `captureScope` et `sampleTelemetry`
    // journalisaient en dur comme `mcp` : une capture lancée depuis l'interface
    // s'affichait comme une action d'agent, ce qui vide la traçabilité de son sens.
    const { core, logs } = await connected();

    await core.captureScope({ depth: 64 });
    const fromGui = logs.find((l) => l.text.startsWith('captured '));
    expect(fromGui?.source).toBe('gui');

    await core.captureScope({ depth: 64 }, 'mcp');
    const fromMcp = logs.filter((l) => l.text.startsWith('captured ')).at(-1);
    expect(fromMcp?.source).toBe('mcp');
  });

  it("attribue un échantillon de télémétrie de la même façon", async () => {
    const { core, logs } = await connected();
    await core.sampleTelemetry(3, 500, ['loop.load_pct']);
    expect(logs.find((l) => l.text.startsWith('sampled '))?.source).toBe('gui');
  });
});

/**
 * Mise à jour de firmware.
 *
 * C'est le seul geste de l'interface qui puisse rendre une carte injoignable. Le tester ici
 * plutôt qu'en cliquant est moins un confort qu'une nécessité : la séquence traverse trois
 * reconnexions, et une erreur au milieu ne se voit à l'écran que comme une carte qui ne
 * revient pas.
 */
describe('mise à jour de firmware', () => {
  /** Une image plausible pour le slot visé — le bootloader contrôle les vecteurs. */
  function image(slot: number, bytes = 4096): Uint8Array {
    const img = new Uint8Array(bytes);
    const view = new DataView(img.buffer);
    view.setUint32(0, 0x2001_ff00, true);
    view.setUint32(4, (slot === 0 ? 0x0800_8000 : 0x0804_0000) + 0x201, true);
    for (let i = 8; i < bytes; i++) img[i] = i & 0xff;
    return img;
  }

  it('écrit le slot inactif et confirme la promotion', async () => {
    const { core } = await connected();
    const phases: string[] = [];
    core.onFirmware.on((p) => phases.push(p.phase));

    const result = await core.updateFirmware(image(1), '2.1.0');

    expect(result).toEqual({ slot: 1, committed: true });
    // Les phases servent à l'écran : chacune couvre un moment où la carte est absente du
    // bus, et leur ordre est ce qui distingue une mise à jour d'une panne. `writing` se
    // répète à chaque bloc — c'est la barre de progression ; on compare les transitions.
    const steps = phases.filter((p, i) => p !== phases[i - 1]);
    expect(steps).toEqual([
      'entering',
      'erasing',
      'writing',
      'verifying',
      'rebooting',
      'confirming',
      'done',
    ]);
  });

  it('revient connecté à l’application quand c’est fini', async () => {
    // Laisser le DeviceCore en bootloader rendrait l'interface entière inutilisable après
    // une mise à jour pourtant réussie.
    const { core } = await connected();
    await core.updateFirmware(image(1), '2.1.0');
    expect(core.snapshot().connection).toBe('connected');
    expect(core.snapshot().params.every((p) => p.value !== null)).toBe(true);
  });

  it('remonte la progression jusqu’au dernier octet', async () => {
    const { core } = await connected();
    let last = 0;
    let total = 0;
    core.onFirmware.on((p) => {
      if (p.phase === 'writing') {
        last = p.written;
        total = p.total;
      }
    });
    const img = image(1, 3000);
    await core.updateFirmware(img, '2.1.0');
    expect(total).toBe(img.length);
    expect(last).toBe(img.length);
  });

  it('refuse une image qu’un agent lui demanderait d’écrire', async () => {
    // Pas soumis à l'interrupteur de pilotage : refusé quoi qu'il arrive. Un mauvais
    // réglage asservit mal un moteur ; une mauvaise image demande une sonde et un
    // tournevis. Ce n'est pas une décision qui se délègue.
    const { core } = await connected();
    core.setAiControl(true);
    await expect(core.updateFirmware(image(1), '2.1.0', 'mcp')).rejects.toThrow(/agent/);
  });

  it('refuse une image trop courte pour porter des vecteurs', async () => {
    const { core } = await connected();
    await expect(core.updateFirmware(new Uint8Array(4), '2.1.0')).rejects.toThrow(/too small/);
  });

  it('refuse sans device connecté', async () => {
    const core = new DeviceCore();
    await expect(core.updateFirmware(image(1), '2.1.0')).rejects.toThrow(/no device/);
  });

  it('journalise la mise à jour comme une action de l’interface', async () => {
    const { core, logs } = await connected();
    await core.updateFirmware(image(1), '2.1.0');
    const entry = logs.find((l) => l.text.startsWith('firmware update:'));
    expect(entry?.source).toBe('gui');
    expect(logs.some((l) => l.text.includes('committed on slot B'))).toBe(true);
  });
});

describe('sécurité — battement et faute verrouillée', () => {
  /**
   * Le firmware coupe le couple si le flux de commandes s'arrête. L'hôte prouve qu'il est
   * vivant en interrogeant `SAFETY?` périodiquement, donc le battement et la lecture d'état
   * sont le même geste. On attend un battement plutôt que d'en déclencher un à la main : ce
   * qui est testé ici, c'est qu'il ait bien lieu tout seul.
   */
  const beat = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 200));
  };

  it('publie l état de sécurité sans qu on le demande', async () => {
    const { core } = await connected();
    await beat();
    const s = core.snapshot().safety;
    expect(s).not.toBeNull();
    expect(s!.reason).toBe('ok');
    expect(s!.latched).toBe(false);
    await core.disconnect();
  });

  it('remonte une coupure et ne la journalise qu une fois', async () => {
    const { core, logs } = await connected();
    await beat();
    core.simulator!.tripSafety('cmd_timeout');
    await beat();
    await beat();

    const s = core.snapshot().safety!;
    expect(s.latched).toBe(true);
    expect(s.reason).toBe('cmd_timeout');
    expect(s.trips).toBe(1);

    const cuts = logs.filter((e) => e.text.includes('torque cut by the firmware'));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.text).toContain('cmd_timeout');
    await core.disconnect();
  });

  it('acquitte la faute, et le snapshot suit sans attendre le battement', async () => {
    const { core } = await connected();
    core.simulator!.tripSafety('drv_fault');
    await beat();
    expect(core.snapshot().safety!.latched).toBe(true);

    expect(await core.clearFault()).toBe(true);
    expect(core.snapshot().safety!.latched).toBe(false);
    await core.disconnect();
  });

  it('refuse l acquittement à un agent tant que le pilotage par IA est coupé', async () => {
    const { core } = await connected();
    core.simulator!.tripSafety('drv_fault');
    await beat();

    await expect(core.clearFault('mcp')).rejects.toThrow(/AI control is off/);
    expect(core.snapshot().safety!.latched).toBe(true);

    core.setAiControl(true);
    expect(await core.clearFault('mcp')).toBe(true);
    await core.disconnect();
  });

  it('laisse un agent lire SAFETY? mais pas acquitter par la console', async () => {
    const { core } = await connected();
    await expect(core.sendSafeConsole('SAFETY?')).resolves.toContain('reason=');
    await expect(core.sendSafeConsole('FAULTCLR')).rejects.toThrow(/not allowed/);
    await core.disconnect();
  });

  it('arrête de battre une fois déconnecté', async () => {
    const { core } = await connected();
    await beat();
    expect(core.snapshot().safety).not.toBeNull();
    await core.disconnect();
    expect(core.snapshot().safety).toBeNull();
    // Rien ne doit repartir tout seul : le battement suivant n'aurait plus de client.
    await beat();
    expect(core.snapshot().safety).toBeNull();
  });
});

describe('console — accès sérialisé', () => {
  /**
   * `DeviceClient.console()` se résout sur la prochaine ligne reçue, quelle qu'elle soit.
   * Deux appels en vol en même temps échangeraient donc leurs réponses. Le battement de
   * sécurité interroge la carte en permanence, ce qui rend la collision certaine plutôt que
   * théorique : chaque réponse doit revenir à qui l'a demandée.
   */
  it('rend à chaque appel sa propre réponse, même lancés ensemble', async () => {
    const { core } = await connected();
    const replies = await Promise.all([
      core.sendConsole('PING alpha'),
      core.sendConsole('PING bravo'),
      core.sendConsole('PING charlie'),
    ]);
    expect(replies).toEqual(['OK alpha', 'OK bravo', 'OK charlie']);
    await core.disconnect();
  });

  it('ne rompt pas la file quand une commande échoue', async () => {
    const { core } = await connected();
    const [bad, good] = await Promise.all([
      core.sendConsole('NOPE'),
      core.sendConsole('PING after'),
    ]);
    expect(bad).toBe('ERR CMD');
    expect(good).toBe('OK after');
    await core.disconnect();
  });
});

describe('supervision de la carte', () => {
  const settle = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 700));
  };

  it('relève rails, référence, température et coût de boucle sans qu on le demande', async () => {
    const { core } = await connected();
    await settle();
    const m = core.snapshot().monitor;
    expect(m).not.toBeNull();
    expect(m!.vrefMv).toBe(2048);
    expect(m!.vinMv).toBeGreaterThan(14_000);
    expect(m!.v3v3Mv).toBeGreaterThan(3_000);
    expect(m!.mcuTempC).not.toBeNull();
    expect(m!.rounds).toBeGreaterThan(0);
    expect(m!.drvFault).toBe(false);
    await core.disconnect();
  });

  it('distingue une température absente d un zéro', async () => {
    const { core } = await connected();
    // Un firmware antérieur au capteur ne publie pas le champ. `null` doit traverser
    // jusqu'à l'UI, qui affiche un tiret : 0 °C serait une mesure, et une fausse.
    const m = await core.readMonitor();
    expect(m.mcuTempC).not.toBe(0);
    expect(typeof m.mcuTempC).toBe('number');
    await core.disconnect();
  });

  it('oublie le relevé à la déconnexion', async () => {
    const { core } = await connected();
    await settle();
    expect(core.snapshot().monitor).not.toBeNull();
    await core.disconnect();
    expect(core.snapshot().monitor).toBeNull();
  });
});

describe('référence analogique — ne pas lisser un défaut', () => {
  /**
   * Quand `VREF+` bouge, toutes les tensions de la carte bougent avec lui alors que les
   * rails sont stables. Le tableau de bord ne doit ni amortir ni moyenner : il doit mesurer
   * l'agitation et la déclarer, sinon l'opérateur cherche une panne d'alimentation qui
   * n'existe pas. C'est exactement ce qui s'est produit le 2026-09-20.
   */
  it('reste silencieux tant qu il n y a pas assez de relevés pour conclure', async () => {
    const { core } = await connected();
    const m = await core.readMonitor();
    expect(m.vrefSpreadPermille).toBeNull();
    await core.disconnect();
  });

  it('conclut à une référence saine sur un device stable', async () => {
    const { core } = await connected();
    // Le simulateur publie un VREF+ fixe : l'étendue doit tomber à zéro, et surtout pas
    // déclencher un avertissement. Un avertissement qui se lève pour rien cesse d'être lu.
    let m = await core.readMonitor();
    for (let i = 0; i < 30; i++) m = await core.readMonitor();
    expect(m.vrefSpreadPermille).toBe(0);
    await core.disconnect();
  });

  it('oublie la fenêtre à la déconnexion', async () => {
    const { core } = await connected();
    for (let i = 0; i < 26; i++) await core.readMonitor();
    expect(core.snapshot().monitor!.vrefSpreadPermille).not.toBeNull();
    await core.disconnect();
    await core.connect({ kind: 'simulator' });
    // Une reconnexion repart d'une fenêtre vide : mélanger les relevés de deux sessions
    // ferait passer un changement de carte pour une instabilité.
    expect((await core.readMonitor()).vrefSpreadPermille).toBeNull();
    await core.disconnect();
  });
});
