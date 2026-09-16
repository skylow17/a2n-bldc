/*
 * Image de probation volontairement defaillante, batie pour le slot A.
 *
 * Elle demarre, et ne confirme jamais. C'est tout ce qu'elle fait, et c'est tout ce qu'on
 * lui demande : elle sert a prouver sur la carte que le rollback automatique fonctionne.
 * Sans elle, le seul moyen de verifier la probation serait d'attendre qu'un vrai firmware
 * tombe en panne — c'est-a-dire de ne jamais la verifier.
 *
 * Deroulement attendu, une fois ecrite dans le slot inactif puis verifiee :
 *
 *   BOOT_VERIFY -> candidat        BOOT_REBOOT -> le bootloader marque « essaye »,
 *   arme l'IWDG (~2 s) et saute ici. Cette image boucle. L'IWDG deborde, reset.
 *   Le bootloader retrouve la marque, abandonne le candidat, et redemarre l'ancien slot.
 *
 * Ecrite en assembleur et liee avec -nostdlib : pas de HAL, pas de libc, pas de .data a
 * recopier. Une image de test dont l'echec pourrait venir de son propre demarrage ne
 * prouverait rien.
 *
 * Les vecteurs sont reduits a deux mots. Aucune interruption n'est activee — l'IWDG n'en
 * leve pas, il reset — et une faute quelconque arrive au meme endroit qu'une boucle : la
 * carte ne confirme pas. C'est le seul comportement qui compte ici.
 */

  .syntax unified
  .cpu cortex-m4
  .thumb

  .section .isr_vector, "a", %progbits
  .global g_pfnVectors
  .type g_pfnVectors, %object
g_pfnVectors:
  .word _estack
  .word Reset_Handler
  .size g_pfnVectors, . - g_pfnVectors

  .section .text.Reset_Handler, "ax", %progbits
  .global Reset_Handler
  .type Reset_Handler, %function
Reset_Handler:
  /* Ne rien faire, franchement. Pas de WFI : une image en sommeil et une image en boucle
     se comportent pareil vis-a-vis du chien de garde, mais une boucle eveillee se voit
     immediatement a la sonde. */
  b .
  .size Reset_Handler, . - Reset_Handler
