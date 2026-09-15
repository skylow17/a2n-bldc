# a2n-bldc-controller-2 — build
#
# Pas de CMake : la machine de développement n'a que le GCC et le make fournis par
# STM32CubeIDE. Ce Makefile n'exige rien d'autre.
#
#   make            build autonome sans bootloader
#   make flash      programme la carte via SWD (ST-LINK)
#   make size       occupation flash/ram
#   make compdb     génère compile_commands.json pour clangd
#   make clean

# ---------------------------------------------------------------- configuration
TARGET   := a2n-bldc-controller-2
BUILD    := build
DEBUG    ?= 1
OPT      ?= -Og

# Chemins de la toolchain. Les valeurs ci-dessous sont celles du poste de
# reference ; sur une autre machine, copier toolchain.local.mk.example en
# toolchain.local.mk et y mettre les siens. Ce fichier n'est pas suivi par git,
# donc chaque poste garde ses chemins sans jamais provoquer de conflit.
-include toolchain.local.mk

CUBE     ?= C:/Users/echan/STM32Cube/Repository/STM32Cube_FW_G4_V1.6.1
IDE      ?= C:/ST/STM32CubeIDE_1.18.0/STM32CubeIDE/plugins
GCC_DIR  ?= $(IDE)/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.rel1.win32_1.0.0.202411081344/tools/bin
PROG_CLI ?= $(IDE)/com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.win32_2.2.100.202412061334/tools/bin/STM32_Programmer_CLI.exe

PREFIX   := $(GCC_DIR)/arm-none-eabi-
CC       := $(PREFIX)gcc
AS       := $(PREFIX)gcc -x assembler-with-cpp
CP       := $(PREFIX)objcopy
SZ       := $(PREFIX)size

HAL      := $(CUBE)/Drivers/STM32G4xx_HAL_Driver
CMSIS    := $(CUBE)/Drivers/CMSIS
USBLIB   := $(CUBE)/Middlewares/ST/STM32_USB_Device_Library

LDSCRIPT := ld/stm32g473ce_standalone.ld

# ---------------------------------------------------------------- sources
C_SOURCES := \
  Core/Src/main.c \
  Core/Src/board_clock.c \
  Core/Src/dbg_pin.c \
  Core/Src/pwm.c \
  Core/Src/adc_sync.c \
  Core/Src/ctrl.c \
  Core/Src/link_usb.c \
  Core/Src/console.c \
  Core/Src/comm/crc16.c \
  Core/Src/comm/cobs.c \
  Core/Src/comm/frame.c \
  Core/Src/comm/param.c \
  Core/Src/comm/param_table.c \
  Core/Src/comm/proto.c \
  Core/Src/comm/rx_router.c \
  Core/Src/comm/selftest.c \
  Core/Src/stm32g4xx_it.c \
  Core/Src/stm32g4xx_hal_msp.c \
  Core/Src/system_stm32g4xx.c \
  Core/Src/syscalls.c \
  Core/Src/sysmem.c

HAL_SOURCES := \
  $(HAL)/Src/stm32g4xx_hal.c \
  $(HAL)/Src/stm32g4xx_hal_cortex.c \
  $(HAL)/Src/stm32g4xx_hal_rcc.c \
  $(HAL)/Src/stm32g4xx_hal_rcc_ex.c \
  $(HAL)/Src/stm32g4xx_hal_gpio.c \
  $(HAL)/Src/stm32g4xx_hal_pwr.c \
  $(HAL)/Src/stm32g4xx_hal_pwr_ex.c \
  $(HAL)/Src/stm32g4xx_hal_flash.c \
  $(HAL)/Src/stm32g4xx_hal_flash_ex.c \
  $(HAL)/Src/stm32g4xx_hal_flash_ramfunc.c \
  $(HAL)/Src/stm32g4xx_hal_dma.c \
  $(HAL)/Src/stm32g4xx_hal_dma_ex.c \
  $(HAL)/Src/stm32g4xx_hal_exti.c \
  $(HAL)/Src/stm32g4xx_hal_tim.c \
  $(HAL)/Src/stm32g4xx_hal_tim_ex.c \
  $(HAL)/Src/stm32g4xx_hal_adc.c \
  $(HAL)/Src/stm32g4xx_hal_adc_ex.c \
  $(HAL)/Src/stm32g4xx_hal_pcd.c \
  $(HAL)/Src/stm32g4xx_hal_pcd_ex.c \
  $(HAL)/Src/stm32g4xx_ll_usb.c

# Pile USB device ST + classe CDC, lues depuis le depot CubeMX comme le HAL.
USB_SOURCES := \
  USB_Device/App/usb_device.c \
  USB_Device/App/usbd_desc.c \
  USB_Device/App/usbd_cdc_if.c \
  USB_Device/Target/usbd_conf.c \
  $(USBLIB)/Core/Src/usbd_core.c \
  $(USBLIB)/Core/Src/usbd_ctlreq.c \
  $(USBLIB)/Core/Src/usbd_ioreq.c \
  $(USBLIB)/Class/CDC/Src/usbd_cdc.c

ASM_SOURCES := startup/startup_stm32g473xx.s

C_INCLUDES := \
  -ICore/Inc \
  -IUSB_Device/App \
  -IUSB_Device/Target \
  -I$(USBLIB)/Core/Inc \
  -I$(USBLIB)/Class/CDC/Inc \
  -I$(HAL)/Inc \
  -I$(HAL)/Inc/Legacy \
  -I$(CMSIS)/Device/ST/STM32G4xx/Include \
  -I$(CMSIS)/Include

C_DEFS := -DUSE_HAL_DRIVER -DSTM32G473xx
ifeq ($(DEBUG),1)
C_DEFS += -DDEBUG
endif

# ---------------------------------------------------------------- flags
CPU    := -mcpu=cortex-m4
FPU    := -mfpu=fpv4-sp-d16
FLOAT  := -mfloat-abi=hard
MCU    := $(CPU) -mthumb $(FPU) $(FLOAT)

WARN   := -Wall -Wextra -Wshadow -Wundef -Wdouble-promotion \
          -Wno-unused-parameter -Werror=implicit-function-declaration

CFLAGS := $(MCU) $(C_DEFS) $(C_INCLUDES) $(OPT) $(WARN) \
          -std=gnu11 -ffunction-sections -fdata-sections -fno-common
ifeq ($(DEBUG),1)
CFLAGS += -g3 -gdwarf-2
endif
# Affectation differee : $@ n'existe qu'au moment de la recette. Avec := ici,
# -MF recevrait une chaine vide et gcc avalerait le fichier source comme argument.
DEPFLAGS = -MMD -MP -MF $(@:%.o=%.d)

ASFLAGS := $(MCU) $(OPT) -Wall -fdata-sections -ffunction-sections

LDFLAGS := $(MCU) -T$(LDSCRIPT) --specs=nano.specs \
           -Wl,-Map=$(BUILD)/$(TARGET).map,--cref -Wl,--gc-sections \
           -Wl,--print-memory-usage -Wl,--no-warn-rwx-segments -lc -lm -lnosys

# ---------------------------------------------------------------- objets
ALL_C   := $(C_SOURCES) $(HAL_SOURCES) $(USB_SOURCES)
OBJECTS := $(addprefix $(BUILD)/obj/,$(notdir $(ALL_C:.c=.o)))
vpath %.c $(sort $(dir $(ALL_C)))
OBJECTS += $(addprefix $(BUILD)/obj/,$(notdir $(ASM_SOURCES:.s=.o)))
vpath %.s $(sort $(dir $(ASM_SOURCES)))

# ---------------------------------------------------------------- règles
# Diagnostic immediat plutot qu'une cascade de "command not found" : sur un poste
# neuf, l'erreur la plus probable est un chemin de toolchain qui ne correspond pas.
ifeq ($(wildcard $(CC)*),)
  $(info )
  $(info  Compilateur introuvable : $(CC))
  $(info  Copier toolchain.local.mk.example en toolchain.local.mk et y corriger IDE/CUBE.)
  $(info )
  $(error toolchain absente)
endif

.PHONY: all clean flash size compdb

all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).hex $(BUILD)/$(TARGET).bin

$(BUILD)/obj/%.o: %.c Makefile | $(BUILD)/obj
	@echo "  CC   $<"
	@$(CC) -c $(CFLAGS) $(DEPFLAGS) $< -o $@

$(BUILD)/obj/%.o: %.s Makefile | $(BUILD)/obj
	@echo "  AS   $<"
	@$(AS) -c $(ASFLAGS) $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJECTS) $(LDSCRIPT) Makefile
	@echo "  LD   $@"
	@$(CC) $(OBJECTS) $(LDFLAGS) -o $@
	@$(SZ) $@

$(BUILD)/%.hex: $(BUILD)/%.elf
	@$(CP) -O ihex $< $@

$(BUILD)/%.bin: $(BUILD)/%.elf
	@$(CP) -O binary -S $< $@

$(BUILD)/obj:
	@mkdir -p $@

size: $(BUILD)/$(TARGET).elf
	@$(SZ) -A $<

# Bring-up autonome : le HEX porte les adresses, dont les vecteurs a 0x08000000.
flash: $(BUILD)/$(TARGET).hex
	"$(PROG_CLI)" -c port=SWD -w $< -v -rst

compdb:
	@python tools/gen_compile_commands.py

clean:
	@rm -rf $(BUILD)

-include $(wildcard $(BUILD)/obj/*.d)
