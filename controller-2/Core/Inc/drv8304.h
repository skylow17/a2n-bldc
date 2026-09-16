/**
 * @file drv8304.h
 * @brief Driver de grille DRV8304S — SPI2, nFAULT, CAL.
 *
 * Étape 2 du bring-up (M2) : parler au driver, lire ses fautes, et rien d'autre. Aucune
 * fonction ici ne met de tension sur le moteur — le pont reste commandé par `pwm.c`, et
 * `MOE` reste bas tant que rien ne l'a levé.
 *
 * Carte des registres : celle du DRV8323 (même famille, mêmes adresses, mêmes champs), sept
 * registres de 11 bits. Trame SPI de 16 bits : bit 15 = lecture, adresse en 14:11, données
 * en 10:0. Le DRV répond dans la *même* trame pour une écriture (ancienne valeur) et pour une
 * lecture (valeur courante) — pas de trame de suite à envoyer.
 */
#ifndef DRV8304_H
#define DRV8304_H

#include <stdbool.h>
#include <stdint.h>

/* ---------------------------------------------------------------- registres */

#define DRV_REG_FAULT_STATUS_1   0x00U
#define DRV_REG_VGS_STATUS_2     0x01U
#define DRV_REG_DRIVER_CONTROL   0x02U
#define DRV_REG_GATE_DRIVE_HS    0x03U
#define DRV_REG_GATE_DRIVE_LS    0x04U
#define DRV_REG_OCP_CONTROL      0x05U
#define DRV_REG_CSA_CONTROL      0x06U
#define DRV_REG_COUNT            7U

#define DRV_DATA_MASK            0x07FFU

/* Fault Status 1 (0x00) */
#define DRV_FS1_FAULT            (1U << 10)
#define DRV_FS1_VDS_OCP          (1U << 9)
#define DRV_FS1_GDF              (1U << 8)
#define DRV_FS1_UVLO             (1U << 7)
#define DRV_FS1_OTSD             (1U << 6)
#define DRV_FS1_VDS_ANY          0x003FU        /* VDS_HA..VDS_LC */

/* VGS Status 2 (0x01) */
#define DRV_FS2_SA_OCP           (1U << 10)
#define DRV_FS2_SB_OCP           (1U << 9)
#define DRV_FS2_SC_OCP           (1U << 8)
#define DRV_FS2_OTW              (1U << 7)
#define DRV_FS2_CPUV             (1U << 6)
#define DRV_FS2_VGS_ANY          0x003FU        /* VGS_HA..VGS_LC */

/* Driver Control (0x02) */
#define DRV_CTRL_DIS_CPUV        (1U << 9)
#define DRV_CTRL_DIS_GDF         (1U << 8)
#define DRV_CTRL_OTW_REP         (1U << 7)
#define DRV_CTRL_PWM_MODE_MASK   (3U << 5)
#define DRV_CTRL_PWM_MODE_6X     (0U << 5)
#define DRV_CTRL_COAST           (1U << 2)
#define DRV_CTRL_BRAKE           (1U << 1)
#define DRV_CTRL_CLR_FLT         (1U << 0)

/* Valeur de reset de CSA Control (0x06), d'après la fiche technique : CSA_GAIN = 20 V/V,
 * VREF_DIV = 1 (sortie polarisée à VREF/2), SEN_LVL = 1 V. Sert de test de présence :
 * un DRV alimenté et jamais configuré répond exactement cela. */
#define DRV_CSA_CONTROL_RESET    0x0283U

/* ---------------------------------------------------------------- état */

typedef struct
{
  bool     nfault_low;      /**< La broche nFAULT est basse en ce moment.                 */
  uint32_t fault_events;    /**< Fronts descendants vus par l'EXTI depuis le reset.       */
  uint16_t fault_status_1;  /**< Dernière lecture de 0x00, 0 si jamais lue.               */
  uint16_t vgs_status_2;    /**< Dernière lecture de 0x01.                                */
  bool     spi_ok;          /**< Le dernier échange SPI a abouti.                         */
} Drv8304_Status_t;

/* ---------------------------------------------------------------- API */

/** GPIO, SPI2, EXTI sur nFAULT. Ne touche pas au DRV lui-même. */
void Drv8304_Init(void);

/** Lecture d'un registre. Faux si SPI en erreur ou adresse hors carte. */
bool Drv8304_ReadReg(uint8_t reg, uint16_t *value);

/** Écriture d'un registre (11 bits utiles). Faux si SPI en erreur ou adresse hors carte. */
bool Drv8304_WriteReg(uint8_t reg, uint16_t value);

/**
 * Critère de l'étape 2 : le driver répond et une écriture se relit.
 *
 * Bascule `COAST` dans Driver Control, relit, remet la valeur d'origine. `COAST` met les
 * six sorties en haute impédance : c'est le bit dont l'écriture accidentelle est la moins
 * dangereuse — c'est déjà l'état au repos. Vérifie aussi que CSA Control porte sa valeur
 * de reset si le driver n'a jamais été configuré depuis la mise sous tension.
 */
bool Drv8304_Probe(void);

/** Relit 0x00 et 0x01 dans l'état, met à jour `spi_ok`. */
bool Drv8304_ReadFaults(void);

/** Pulse `CLR_FLT`. Les fautes latchées disparaissent si leur cause a disparu. */
bool Drv8304_ClearFaults(void);

/** Broche CAL : haut = les trois CSA sont en calibration d'offset (entrées court-circuitées). */
void Drv8304_SetCal(bool enabled);

/** Instantané cohérent de l'état, lisible depuis la boucle principale. */
void Drv8304_GetStatus(Drv8304_Status_t *out);

/** Appelée par le vecteur EXTI de nFAULT. Coupe le pont, compte, ne parle pas au DRV. */
void Drv8304_OnFaultIrq(void);

#endif /* DRV8304_H */
