/*
 * Image de probation volontairement défaillante — slot A.
 *
 * Voir Boot/Test/trial_fail.s. Le script est réduit au strict nécessaire : deux mots de
 * vecteurs et une boucle. Pas de .data, pas de .bss, pas de tas.
 *
 * Le pointeur de pile initial doit rester plausible pour `BootFlash_VectorsPlausible()`,
 * sinon le bootloader refuserait de sauter et le test ne prouverait rien — il montrerait
 * seulement que le contrôle des vecteurs marche, ce qui se vérifie déjà hors cible.
 */

ENTRY(Reset_Handler)

MEMORY
{
  RAM    (xrw) : ORIGIN = 0x20000000, LENGTH = 0x1FF00
  FLASH  (rx)  : ORIGIN = 0x08008000, LENGTH = 224K
}

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector))
    . = ALIGN(4);
  } >FLASH

  .text :
  {
    . = ALIGN(4);
    *(.text)
    *(.text*)
    . = ALIGN(4);
  } >FLASH

  /DISCARD/ : { *(.ARM.exidx*) *(.comment) }

  .ARM.attributes 0 : { *(.ARM.attributes) }
}
