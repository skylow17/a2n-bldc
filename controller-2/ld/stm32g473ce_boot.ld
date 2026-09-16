/*
 * a2n-bldc-controller-2 — bootloader
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

/*
 * Le bootloader tient dans les 32 premiers kilo-octets et n en sort pas : c est le seul
 * morceau de flash que la mise à jour sans sonde ne réécrit jamais, et donc le seul qui
 * doive rester juste quoi qu il arrive. Un dépassement se voit au link, pas à l exécution.
 */
ENTRY(Reset_Handler)

_estack         = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size  = 0x400;
_Min_Stack_Size = 0x800;

MEMORY
{
  RAM    (xrw) : ORIGIN = 0x20000000, LENGTH = 0x1FF00
  FLASH  (rx)  : ORIGIN = 0x08000000, LENGTH = 32K
}

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
