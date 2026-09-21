# a2n-bldc-controller-2 — build
#
# Pas de CMake : la machine de développement n'a que le GCC et le make fournis par
# STM32CubeIDE. Ce Makefile n'exige rien d'autre.
#
#   make            build autonome sans bootloader
#   make flash      programme la carte via SWD (ST-LINK)
#   make provision  force le boot depuis la Flash principale (une fois par carte)
#   make flash-check programme, redemarre et valide la liaison sur la vraie carte
#   make size       occupation flash/ram
#   make compdb     génère compile_commands.json pour clangd
#   make clean

# ---------------------------------------------------------------- configuration
IMAGE    ?= standalone
TARGET   := a2n-bldc-controller-2
BUILD    := build
DEBUG    ?= 1
OPT      ?= -Og

ifeq ($(IMAGE),bootloader)
  TARGET := a2n-bldc-bootloader
  BUILD  := build/bootloader
  OPT    := -Os
else ifeq ($(IMAGE),slot-a)
  TARGET := a2n-bldc-slot-a
  BUILD  := build/slot-a
else ifeq ($(IMAGE),slot-b)
  TARGET := a2n-bldc-slot-b
  BUILD  := build/slot-b
endif

# Chemins de la toolchain. Les valeurs ci-dessous sont celles du poste de
# reference ; sur une autre machine, copier toolchain.local.mk.example en
# toolchain.local.mk et y mettre les siens. Ce fichier n'est pas suivi par git,
# donc chaque poste garde ses chemins sans jamais provoquer de conflit.
-include toolchain.local.mk

CUBE     ?= C:/Users/echan/STM32Cube/Repository/STM32Cube_FW_G4_V1.6.1
IDE      ?= C:/ST/STM32CubeIDE_1.18.0/STM32CubeIDE/plugins
GCC_DIR  ?= $(IDE)/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.rel1.win32_1.0.0.202411081344/tools/bin
PROG_CLI ?= $(IDE)/com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.win32_2.2.100.202412061334/tools/bin/STM32_Programmer_CLI.exe
INTERFACE ?= ../interface
BOARD_PORT ?=
CLI_PORT_ARG = $(if $(strip $(BOARD_PORT)),--port $(BOARD_PORT),)

PREFIX   := $(GCC_DIR)/arm-none-eabi-
CC       := $(PREFIX)gcc
AS       := $(PREFIX)gcc -x assembler-with-cpp
CP       := $(PREFIX)objcopy
SZ       := $(PREFIX)size

HAL      := $(CUBE)/Drivers/STM32G4xx_HAL_Driver
CMSIS    := $(CUBE)/Drivers/CMSIS
USBLIB   := $(CUBE)/Middlewares/ST/STM32_USB_Device_Library

ifeq ($(IMAGE),bootloader)
  LDSCRIPT := ld/stm32g473ce_boot.ld
else ifeq ($(IMAGE),slot-a)
  LDSCRIPT := ld/stm32g473ce_slotA.ld
else ifeq ($(IMAGE),slot-b)
  LDSCRIPT := ld/stm32g473ce_slotB.ld
else
  LDSCRIPT := ld/stm32g473ce_standalone.ld
endif

# ---------------------------------------------------------------- sources
APP_C_SOURCES := \
  Core/Src/main.c \
  Core/Src/board_clock.c \
  Core/Src/boot_shared.c \
  Core/Src/dbg_pin.c \
  Core/Src/drv8304.c \
  Core/Src/pwm.c \
  Core/Src/adc_sync.c \
  Core/Src/sensors.c \
  Core/Src/encoder.c \
  Core/Src/imot.c \
  Core/Src/safety.c \
  Core/Src/ctrl.c \
  Core/Src/link_usb.c \
  Core/Src/console.c \
  Core/Src/comm/crc16.c \
  Core/Src/comm/cobs.c \
  Core/Src/comm/frame.c \
  Core/Src/comm/param.c \
  Core/Src/comm/param_table.c \
  Core/Src/comm/signals.c \
  Core/Src/comm/scope.c \
  Core/Src/comm/proto.c \
  Core/Src/comm/rx_router.c \
  Core/Src/comm/selftest.c \
  Core/Src/stm32g4xx_it.c \
  Core/Src/stm32g4xx_hal_msp.c \
  Core/Src/system_stm32g4xx.c \
  Core/Src/syscalls.c \
  Core/Src/sysmem.c

BOOT_C_SOURCES := \
  Boot/Src/boot_main.c \
  Boot/Src/boot_it.c \
  Boot/Src/boot_flash.c \
  Boot/Src/boot_proto.c \
  Boot/Src/boot_rx.c \
  Core/Src/boot_shared.c \
  Core/Src/board_clock.c \
  Core/Src/link_usb.c \
  Core/Src/comm/crc16.c \
  Core/Src/comm/cobs.c \
  Core/Src/comm/frame.c \
  Core/Src/system_stm32g4xx.c \
  Core/Src/syscalls.c \
  Core/Src/sysmem.c

C_SOURCES := $(if $(filter bootloader,$(IMAGE)),$(BOOT_C_SOURCES),$(APP_C_SOURCES))

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
  $(HAL)/Src/stm32g4xx_hal_i2c.c \
  $(HAL)/Src/stm32g4xx_hal_i2c_ex.c \
  $(HAL)/Src/stm32g4xx_hal_spi.c \
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
  -IBoot/Inc \
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
ifneq ($(filter slot-a slot-b,$(IMAGE)),)
C_DEFS += -DAPP_WITH_BOOTLOADER
endif
# La poignee de main SRAM est un seul fichier pour les deux images : c est un protocole a
# deux bouts, et le separer laisserait les deux moities diverger sans que rien ne le dise.
# BOOT_IMAGE choisit le bout a batir.
ifeq ($(IMAGE),bootloader)
C_DEFS += -DBOOT_IMAGE
endif
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

.PHONY: all clean flash provision flash-check size compdb bootloader app-slot-a app-slot-b boot-images install-bootloader boot-trial-fail-a

all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).hex $(BUILD)/$(TARGET).bin

bootloader:
	@$(MAKE) IMAGE=bootloader all

app-slot-a:
	@$(MAKE) IMAGE=slot-a all

app-slot-b:
	@$(MAKE) IMAGE=slot-b all

boot-images: bootloader app-slot-a app-slot-b

# Image inerte réservée au test négatif A/B. Elle ne configure aucun périphérique et
# laisse volontairement expirer l'IWDG de probation, afin de prouver le rollback.
TRIAL_FAIL_BUILD := build/boot-trial-fail-a
TRIAL_FAIL_OBJ   := $(TRIAL_FAIL_BUILD)/trial_fail.o
TRIAL_FAIL_ELF   := $(TRIAL_FAIL_BUILD)/a2n-bldc-trial-fail-a.elf
TRIAL_FAIL_BIN   := $(TRIAL_FAIL_BUILD)/a2n-bldc-trial-fail-a.bin

boot-trial-fail-a: $(TRIAL_FAIL_BIN)

$(TRIAL_FAIL_OBJ): Boot/Test/trial_fail.s Makefile | $(TRIAL_FAIL_BUILD)
	@echo "  AS   $<"
	@$(AS) -c $(MCU) -Os -Wall $< -o $@

$(TRIAL_FAIL_ELF): $(TRIAL_FAIL_OBJ) ld/stm32g473ce_trial_fail_A.ld Makefile
	@echo "  LD   $@"
	@$(CC) $(MCU) -nostdlib -Tld/stm32g473ce_trial_fail_A.ld \
	  -Wl,-Map=$(TRIAL_FAIL_BUILD)/a2n-bldc-trial-fail-a.map,--gc-sections $< -o $@
	@$(SZ) $@

$(TRIAL_FAIL_BIN): $(TRIAL_FAIL_ELF)
	@$(CP) -O binary -S $< $@

$(TRIAL_FAIL_BUILD):
	@powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -Path '$@' | Out-Null"

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
	@powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -Path '$@' | Out-Null"

size: $(BUILD)/$(TARGET).elf
	@$(SZ) -A $<

# Bring-up autonome : le HEX porte les adresses, dont les vecteurs a 0x08000000.
flash: $(BUILD)/$(TARGET).hex
	"$(PROG_CLI)" -c port=SWD -w $< -v -rst

# Installation initiale par SWD : bootloader puis application A relogée. Cette cible est
# volontairement distincte de `flash` pour qu'un bring-up quotidien ne remplace jamais le
# layout A/B par accident.
install-bootloader: boot-images
	"$(PROG_CLI)" -c port=SWD -e all
	"$(PROG_CLI)" -c port=SWD -w build/bootloader/a2n-bldc-bootloader.hex -v
	"$(PROG_CLI)" -c port=SWD -w build/slot-a/a2n-bldc-slot-a.hex -v -rst

# Provisionnement unique par carte. PB8/BOOT0 n'a pas de pull-down externe sur la
# revision A : ignorer la broche evite un demarrage accidentel dans la ROM systeme.
# SWD reste disponible pour restaurer ces option bytes si necessaire.
provision:
	"$(PROG_CLI)" -c port=SWD -ob nSWBOOT0=0 nBOOT0=1
	"$(PROG_CLI)" -c port=SWD mode=HOTPLUG -ob displ

# Recette quotidienne : le firmware attend deja 500 ms avant d'attacher l'USB ; les
# 2 s supplementaires laissent Windows creer le port avant que la CLI ne l'ouvre.
# BOARD_PORT=COM3 reste possible, sinon la CLI reconnait le VID/PID automatiquement.
flash-check: flash
	@powershell.exe -NoProfile -Command "Start-Sleep -Seconds 2"
	@cd "$(INTERFACE)" && npm run cli -- check $(CLI_PORT_ARG)

compdb:
	@python tools/gen_compile_commands.py

clean:
	@rm -rf $(BUILD)

-include $(wildcard $(BUILD)/obj/*.d)
