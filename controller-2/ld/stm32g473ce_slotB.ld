/*
 * a2n-bldc-controller-2 — application, slot B
 * STM32G473CEU3 : 512 ko flash, 128 ko SRAM
 *

 * Découpage aligné sur les deux banques de la flash (256 ko chacune) : le slot A vit
 * entièrement en banque 1 et le slot B en banque 2. Le bootloader peut donc effacer et
 * écrire le slot B pendant qu il s exécute depuis la banque 1, sans stall de lecture.
 *
 *   0x08000000  bootloader    32 ko   ] banque 1
 *   0x08008000  slot A       224 ko   ]
 *   0x08040000  slot B       224 ko   ] banque 2
 *   0x08078000  nvm params    16 ko   ]
 *   0x0807C000  metadata      16 ko   ]   crc, version, valid, boot_count par slot
 *
 * Les 256 derniers octets de la SRAM sont soustraits à RAM (LENGTH = 0x1FF00) et réservés à
 * la poignée de main entre les deux images — voir Core/Inc/boot_shared.h. Les trois scripts
 * portent la même amputation : une seule qui l oublierait écraserait le dialogue.
 */
ENTRY(Reset_Handler)

_estack         = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size  = 0x400;
_Min_Stack_Size = 0x800;

MEMORY
{
  /* SRAM1 + SRAM2 seules. La CCM SRAM, visible aussi à 0x20018000 à leur suite, est
   * adressée par son alias du bus d'instructions : on y exécute le chemin de l'ISR. Ses 256
   * derniers octets (0x10007F00 = 0x2001FF00) sont le passage de relais avec le bootloader. */
  RAM    (xrw) : ORIGIN = 0x20000000, LENGTH = 0x18000
  CCMRAM (xrw) : ORIGIN = 0x10000000, LENGTH = 0x7F00
  FLASH  (rx)  : ORIGIN = DEFINED(APP_FLASH_ORIGIN) ? APP_FLASH_ORIGIN : 0x08040000,
                  LENGTH = 224K
}

SECTIONS
{
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector))
    . = ALIGN(4);
  } >FLASH

  /* Chemin de l'ISR de contrôle, exécuté depuis la CCM SRAM : zéro état d'attente, là où la
   * flash en impose quatre à 144 MHz. Entre deux passages, la superloop évince le petit cache
   * de la flash, et chaque ISR repayait ses défauts de cache — 79 cycles pour une fonction qui
   * ne fait qu'une comparaison, mesuré le 2026-09-26. La liste des fichiers est celle de
   * `ISR_PATH` dans le Makefile, moins `stm32g4xx_it.o` : les vecteurs de faute doivent
   * fonctionner avant la copie. Copié par `main`, puis protégé en écriture (`SYSCFG_SWPR`).
   * Placé avant `.text` : une section d'entrée va au premier motif qui la désigne. */
  .ccmram_text :
  {
    . = ALIGN(4);
    _sccm_text = .;
    *ctrl.o(.text .text.*)
    *adc_sync.o(.text .text.*)
    *encoder.o(.text .text.*)
    *imot.o(.text .text.*)
    *safety.o(.text .text.*)
    *openloop.o(.text .text.*)
    *pwm.o(.text .text.*)
    *scope.o(.text .text.*)
    *signals.o(.text .text.*)
    *dbg_pin.o(.text .text.*)
    . = ALIGN(4);
    _eccm_text = .;
  } >CCMRAM AT> FLASH
  _siccm_text = LOADADDR(.ccmram_text);

  .text :
  {
    . = ALIGN(4);
    *(.text)
    *(.text*)
    *(.glue_7)
    *(.glue_7t)
    *(.eh_frame)
    KEEP (*(.init))
    KEEP (*(.fini))
    . = ALIGN(4);
    _etext = .;
  } >FLASH

  .rodata :
  {
    . = ALIGN(4);
    *(.rodata)
    *(.rodata*)
    . = ALIGN(4);
  } >FLASH

  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } >FLASH
  .ARM       : { __exidx_start = .; *(.ARM.exidx*) __exidx_end = .; } >FLASH

  .preinit_array :
  {
    PROVIDE_HIDDEN (__preinit_array_start = .);
    KEEP (*(.preinit_array*))
    PROVIDE_HIDDEN (__preinit_array_end = .);
  } >FLASH
  .init_array :
  {
    PROVIDE_HIDDEN (__init_array_start = .);
    KEEP (*(SORT(.init_array.*)))
    KEEP (*(.init_array*))
    PROVIDE_HIDDEN (__init_array_end = .);
  } >FLASH
  .fini_array :
  {
    PROVIDE_HIDDEN (__fini_array_start = .);
    KEEP (*(SORT(.fini_array.*)))
    KEEP (*(.fini_array*))
    PROVIDE_HIDDEN (__fini_array_end = .);
  } >FLASH

  _sidata = LOADADDR(.data);

  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data)
    *(.data*)
    *(.RamFunc)
    *(.RamFunc*)
    . = ALIGN(4);
    _edata = .;
  } >RAM AT> FLASH

  . = ALIGN(4);
  .bss :
  {
    _sbss = .;
    __bss_start__ = _sbss;
    *(.bss)
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
    __bss_end__ = _ebss;
  } >RAM

  ._user_heap_stack :
  {
    . = ALIGN(8);
    PROVIDE ( end = . );
    PROVIDE ( _end = . );
    . = . + _Min_Heap_Size;
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
  } >RAM

  /DISCARD/ : { libc.a ( * ) libm.a ( * ) libgcc.a ( * ) }

  .ARM.attributes 0 : { *(.ARM.attributes) }
}
