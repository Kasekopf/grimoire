import {
  bjornifyFamiliar,
  booleanModifier,
  canEquip,
  cliExecute,
  enthroneFamiliar,
  equip,
  equippedItem,
  Familiar,
  haveEquipped,
  Item,
  logprint,
  equippedAmount as mafiaEquippedAmount,
  weaponHands as mafiaWeaponHands,
  myBjornedFamiliar,
  myEnthronedFamiliar,
  myFamiliar,
  Slot,
  toSlot,
  useFamiliar,
} from "kolmafia";
import {
  $familiar,
  $item,
  $skill,
  $slot,
  $slots,
  applyModes,
  get,
  have,
  Modes as LibramModes,
  Requirement,
} from "libram";

const FORCE_REFRESH_REQUIREMENT = new Requirement([], { forceUpdate: true });

export const outfitSlots = [
  "hat",
  "back",
  "weapon",
  "offhand",
  "shirt",
  "pants",
  "acc1",
  "acc2",
  "acc3",
  "famequip",
] as const;

export type OutfitSlot = typeof outfitSlots[number];

export type OutfitEquips = Partial<{ [slot in OutfitSlot]: Item | Item[] }>;

export const riderSlots = ["buddy-bjorn", "crown-of-thrones"] as const;

export type RiderSlot = typeof riderSlots[number];

export type OutfitRiders = Partial<{ [slot in RiderSlot]: Familiar | Familiar[] }>;

export type Equippable = Item | Familiar | OutfitSpec | Item[] | Outfit;

export interface OutfitSpec extends OutfitEquips {
  equip?: Item[]; // Items to be equipped in any slot
  modes?: Modes; // Modes to set on particular items
  modifier?: string | string[]; // Modifier to maximize
  familiar?: Familiar; // Familiar to use
  avoid?: Item[]; // Items that cause issues and so should not be equipped
  skipDefaults?: boolean; // Do not equip default equipment; fully maximize
  riders?: OutfitRiders; // Familiars to bjornify-enthrone
  bonuses?: Map<Item, number>;
}

export type Modes = {
  backupcamera?: "ml" | "meat" | "init";
  umbrella?:
    | "broken"
    | "forward-facing"
    | "bucket style"
    | "pitchfork style"
    | "constantly twirling"
    | "cocoon";
  snowsuit?: "eyebrows" | "smirk" | "nose" | "goatee" | "hat";
  edpiece?: "bear" | "owl" | "puma" | "hyena" | "mouse" | "weasel" | "fish";
  retrocape?: [
    "vampire" | "heck" | "robot" | undefined,
    "hold" | "thrill" | "kiss" | "kill" | undefined
  ]; // Undefined means "don't care"
  parka?: "kachungasaur" | "dilophosaur" | "ghostasaurus" | "spikolodon" | "pterodactyl";
};

const weaponHands = (i?: Item) => (i ? mafiaWeaponHands(i) : 0);

const modeableCommands = [
  "backupcamera",
  "umbrella",
  "snowsuit",
  "edpiece",
  "retrocape",
  "parka",
] as const;

export class Outfit {
  equips: Map<Slot, Item> = new Map<Slot, Item>();
  riders: Map<Slot, Familiar> = new Map<Slot, Familiar>();
  modes: Modes = {};
  skipDefaults = false;
  familiar?: Familiar;
  modifier: string[] = [];
  avoid: Item[] = [];
  bonuses = new Map<Item, number>();

  /**
   * Create an outfit from your current player state.
   */
  static current(): Outfit {
    const outfit = new Outfit();

    const familiar = myFamiliar();
    if (outfit.equip(familiar)) {
      throw `Failed to create outfit from current state (expected: familiar ${familiar})`;
    }

    for (const slotName of outfitSlots) {
      const slot =
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName);
      const item = equippedItem(slot);
      if (!outfit.equip(item, slot)) {
        throw `Failed to create outfit from current state (expected: ${slot} ${item})`;
      }
    }

    if (haveEquipped($item`Crown of Thrones`))
      outfit.riders.set($slot`crown-of-thrones`, myEnthronedFamiliar());
    if (haveEquipped($item`Buddy Bjorn`))
      outfit.riders.set($slot`buddy-bjorn`, myBjornedFamiliar());

    outfit.setModes(getCurrentModes());
    return outfit;
  }

  /**
   * Check how many of an item is equipped on the outfit.
   */
  public equippedAmount(item: Item): number {
    return [...this.equips.values()].filter((i) => i === item).length;
  }

  private isAvailable(item: Item): boolean {
    if (this.avoid?.includes(item)) return false;
    if (!have(item, this.equippedAmount(item) + 1)) return false;
    if (booleanModifier(item, "Single Equip") && this.equippedAmount(item) > 0) return false;
    return true;
  }

  /**
   * Check whether an item is equipped on the outfit, optionally in a specific slot.
   */
  public haveEquipped(item: Item, slot?: Slot): boolean {
    if (slot === undefined) return this.equippedAmount(item) > 0;
    return this.equips.get(slot) === item;
  }

  private equipItemNone(item: Item, slot?: Slot): boolean {
    if (item !== $item.none) return false;
    if (slot === undefined) return true;
    if (this.equips.has(slot)) return false;
    this.equips.set(slot, item);
    return true;
  }

  private equipNonAccessory(item: Item, slot?: Slot) {
    if ($slots`acc1, acc2, acc3`.includes(toSlot(item))) return false;
    if (slot !== undefined && slot !== toSlot(item)) return false;
    if (this.equips.has(toSlot(item))) return false;
    switch (toSlot(item)) {
      case $slot`off-hand`:
        if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
          return false;
        }
        break;
      case $slot`familiar`:
        if (this.familiar !== undefined && !canEquip(this.familiar, item)) return false;
    }
    if (toSlot(item) !== $slot`familiar` && !canEquip(item)) return false;
    this.equips.set(toSlot(item), item);
    return true;
  }

  private equipAccessory(item: Item, slot?: Slot): boolean {
    if (![undefined, ...$slots`acc1, acc2, acc3`].includes(slot)) return false;
    if (toSlot(item) !== $slot`acc1`) return false;
    if (!canEquip(item)) return false;
    if (slot === undefined) {
      // We don't care which of the accessory slots we equip in
      const empty = $slots`acc1, acc2, acc3`.find((s) => !this.equips.has(s));
      if (empty === undefined) return false;
      this.equips.set(empty, item);
    } else {
      if (this.equips.has(slot)) return false;
      this.equips.set(slot, item);
    }
    return true;
  }

  private equipUsingDualWield(item: Item, slot?: Slot): boolean {
    if (![undefined, $slot`off-hand`].includes(slot)) return false;
    if (toSlot(item) !== $slot`weapon`) return false;
    if (this.equips.has($slot`weapon`) && weaponHands(this.equips.get($slot`weapon`)) !== 1) {
      return false;
    }
    if (this.equips.has($slot`off-hand`)) return false;
    if (!have($skill`Double-Fisted Skull Smashing`)) return false;
    if (weaponHands(item) !== 1) return false;
    if (!canEquip(item)) return false;
    this.equips.set($slot`off-hand`, item);
    return true;
  }

  private getHoldingFamiliar(item: Item): Familiar | undefined {
    switch (toSlot(item)) {
      case $slot`weapon`:
        return $familiar`Disembodied Hand`;
      case $slot`off-hand`:
        return $familiar`Left-Hand Man`;
      default:
        return undefined;
    }
  }

  /**
   * Returns the bonus value associated with a given item.
   * @param item The item to check the bonus of.
   * @returns The bonus assigned to that item.
   */
  public getBonus(item: Item): number {
    return this.bonuses.get(item) ?? 0;
  }

  /**
   * Sets the bonus value of an item equal to a given value, overriding any current bonus assigned.
   *
   * Only triggers on items that may be equipped to this outfit.
   * @param item The item to try to apply a bonus to.
   * @param value The value to try to apply.
   * @returns Whether the bonus was successfully asigned.
   */
  public setBonus(item: Item, value: number): boolean {
    const can = this.canEquip(item);
    if (can) this.bonuses.set(item, value);
    return can;
  }

  /**
   * Adds a value to any existing bonus this item has; if it started without a bonus, sets the bonus equal to that value.
   *
   * Only triggers on items that may be equipped to this outfit.
   * @param item The item to try to add a bonus to.
   * @param value The value to try to add.
   * @returns The total assigned bonus to that item.
   */
  public addBonus(item: Item, value: number): number {
    const previous = this.getBonus(item);
    this.setBonus(item, previous + value);
    return this.getBonus(item);
  }

  private equipUsingFamiliar(item: Item, slot?: Slot): boolean {
    if (![undefined, $slot`familiar`].includes(slot)) return false;
    if (this.equips.has($slot`familiar`)) return false;
    if (booleanModifier(item, "Single Equip")) return false;
    const familiar = this.getHoldingFamiliar(item);
    if (familiar === undefined || !this.equip(familiar)) return false;
    this.equips.set($slot`familiar`, item);
    return true;
  }

  private equipItem(item: Item, slot?: Slot): boolean {
    return (
      this.haveEquipped(item, slot) ||
      this.equipItemNone(item, slot) ||
      (this.isAvailable(item) &&
        (this.equipNonAccessory(item, slot) ||
          this.equipAccessory(item, slot) ||
          this.equipUsingDualWield(item, slot) ||
          this.equipUsingFamiliar(item, slot)))
    );
  }

  private equipFamiliar(familiar: Familiar): boolean {
    if (familiar === this.familiar) return true;
    if (this.familiar !== undefined) return false;
    if (familiar !== $familiar.none) {
      if (!have(familiar)) return false;
      if (Array.from(this.riders.values()).includes(familiar)) return false;
    }
    const item = this.equips.get($slot`familiar`);
    if (item !== undefined && item !== $item.none && !canEquip(familiar, item)) return false;
    this.familiar = familiar;
    return true;
  }

  private equipSpec(spec: OutfitSpec): boolean {
    let succeeded = true;
    for (const slotName of outfitSlots) {
      const slot =
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName);
      const itemOrItems = spec[slotName];
      if (itemOrItems !== undefined && !this.equip(itemOrItems, slot)) succeeded = false;
    }
    for (const item of spec?.equip ?? []) {
      if (!this.equip(item)) succeeded = false;
    }
    if (spec?.familiar !== undefined) {
      if (!this.equip(spec.familiar)) succeeded = false;
    }
    this.avoid.push(...(spec?.avoid ?? []));
    this.skipDefaults = this.skipDefaults || (spec.skipDefaults ?? false);
    if (spec.modifier) {
      if (Array.isArray(spec.modifier)) this.modifier.push(...spec.modifier);
      else this.modifier.push(spec.modifier);
    }
    if (spec.modes) {
      if (!this.setModes(spec.modes)) {
        succeeded = false;
      }
    }
    if (spec.riders) {
      if (spec.riders["buddy-bjorn"] && !this.bjornify(spec.riders["buddy-bjorn"]))
        succeeded = false;
      if (spec.riders["crown-of-thrones"] && !this.enthrone(spec.riders["crown-of-thrones"]))
        succeeded = false;
    }
    if (spec.bonuses) {
      for (const [item, value] of spec.bonuses) {
        succeeded &&= value + this.getBonus(item) === this.addBonus(item, value);
      }
    }
    return succeeded;
  }

  /**
   * Equip the first thing that can be equipped to the outfit.
   *
   * @param things The things to equip.
   * @param slot The slot to equip them.
   * @returns True if one of the things is equipped, and false otherwise.
   */
  public equipFirst(things: Item[] | Familiar[], slot?: Slot): boolean {
    return things.some((val) => this.equip(val, slot));
  }

  /**
   * Equip a thing to the outfit.
   *
   * If no slot is given, then the thing will be equipped wherever possible
   * (possibly using dual-wielding, any of the accessory slots, or as
   * familiar equipment). If it is impossible to add this thing anywhere to
   * the outfit, this function will return false.
   *
   * If a slot is given, the item will be equipped only in that slot. If the
   * slot is filled with a different item, this function will return false.
   *
   * If the thing is already equipped in the provided slot, or if no slot is
   * given and the thing is already equipped in any slot, this function will
   * return true and not change the outfit.
   *
   * @param thing The thing or things to equip.
   * @param slot The slot to equip them.
   * @returns True if the thing was sucessfully equipped, and false otherwise.
   */
  equip(thing: Equippable, slot?: Slot): boolean {
    if (Array.isArray(thing)) {
      if (slot !== undefined) return this.equipFirst(thing, slot);
      return thing.every((val) => this.equip(val));
    }
    if (thing instanceof Item) return this.equipItem(thing, slot);
    if (thing instanceof Familiar) return this.equipFamiliar(thing);
    if (thing instanceof Outfit) return this.equipSpec(thing.spec());
    return this.equipSpec(thing);
  }

  /**
   * Create a new outfit that confirms to a given spec. Return null if the outfit cannot be successfully created as such
   * @param spec The spec around which to build the outfit.
   * @param error An error to throw if we fail to equip the outfit; if this parameter is null, the return type will be Outfit | null
   * @returns A new outfit containing the inputted spec, or null if that is impossible.
   */
  static from(spec: OutfitSpec): Outfit | null;
  static from(spec: OutfitSpec, error: null): Outfit | null;
  static from(spec: OutfitSpec, error: Error): Outfit;
  static from(spec: OutfitSpec, error: Error | null = null): Outfit | null {
    const outfit = new Outfit();

    const success = outfit.equip(spec);
    if (!success && error) throw error;
    return success ? outfit : null;
  }

  /**
   * Add a bjornified familiar to the outfit.
   *
   * This function does *not* equip the buddy bjorn itself; it must be equipped separately.
   *
   * If a familiar is already specified for the buddy bjorn that is different from the provided target, this function will return false and not change the buddy bjorn.
   * @param target The familiar to bjornify, or a ranked list of familiars to try to bjornify.
   * @returns True if we successfully set the bjorn to a valid target.
   */
  bjornify(target: Familiar | Familiar[]): boolean {
    const current = this.riders.get($slot`buddy-bjorn`);
    if (current) {
      if (
        Array.isArray(target)
          ? (target as (Familiar | undefined)[]).includes(current)
          : current === target
      ) {
        return true;
      }
      return false;
    }

    if (Array.isArray(target)) {
      const fam = target.find(
        (f) => have(f) && this.familiar !== f && this.riders.get($slot`crown-of-thrones`) !== f
      );
      if (fam) {
        this.riders.set($slot`buddy-bjorn`, fam);
        return true;
      }
      return false;
    } else {
      if (
        have(target) &&
        this.familiar !== target &&
        !Array.from(this.riders.values()).includes(target)
      ) {
        this.riders.set($slot`buddy-bjorn`, target);
        return true;
      }
      return false;
    }
  }

  /**
   * Add anenthroned familiar to the outfit.
   *
   * This function does *not* equip the crown of thrones itself; it must be equipped separately.
   *
   * If a familiar is already specified for the crown of thrones that is different from the provided target, this function will return false and not change the crown of thrones.
   * @param target The familiar to enthrone, or a ranked list of familiars to try to enthrone.
   * @returns True if we successfully set the enthrone to a valid target.
   */
  enthrone(target: Familiar | Familiar[]): boolean {
    const current = this.riders.get($slot`crown-of-thrones`);
    if (current) {
      if (
        Array.isArray(target)
          ? (target as (Familiar | undefined)[]).includes(current)
          : current === target
      ) {
        return true;
      }
      return false;
    }

    if (Array.isArray(target)) {
      const fam = target.find(
        (f) => have(f) && this.familiar !== f && this.riders.get($slot`buddy-bjorn`) !== f
      );
      if (fam) {
        this.riders.set($slot`crown-of-thrones`, fam);
        return true;
      }
      return false;
    } else {
      if (
        have(target) &&
        this.familiar !== target &&
        !Array.from(this.riders.values()).includes(target)
      ) {
        this.riders.set($slot`crown-of-thrones`, target);
        return true;
      }
      return false;
    }
  }

  /**
   * Set the provided modes for items that may be equipped in the outfit.
   *
   * This function does *not* equip items for the set modes; they must be
   * equipped separately.
   *
   * If a mode is already set for an item that is different from the provided
   * mode, this function will return false and not change the mode for that
   * item. (But other modes might still be changed if they are compatible.)
   *
   * Note that the superhero and instuctions of a retrocape can be set
   * independently (`undefined` is treated as "don't care").
   *
   * @param modes Modes to set in this outfit.
   * @returns True if all modes were sucessfully set, and false otherwise.
   */
  setModes(modes: Modes): boolean {
    let compatible = true;

    // Check if the new modes are compatible with existing modes
    for (const mode of modeableCommands) {
      if (mode === "retrocape") continue; // checked below
      if (this.modes[mode] && modes[mode] && this.modes[mode] !== modes[mode]) {
        compatible = false;
      }
    }

    // Check if retrocape modes are compatible
    // (Parts that are undefined are compatible with everything)
    if (this.modes["retrocape"] && modes["retrocape"]) {
      if (
        this.modes["retrocape"][0] &&
        modes["retrocape"][0] &&
        this.modes["retrocape"][0] !== modes["retrocape"][0]
      ) {
        compatible = false;
      }

      if (
        this.modes["retrocape"][1] &&
        modes["retrocape"][1] &&
        this.modes["retrocape"][1] !== modes["retrocape"][1]
      ) {
        compatible = false;
      }

      this.modes["retrocape"][0] = this.modes["retrocape"][0] ?? modes["retrocape"][0];
      this.modes["retrocape"][1] = this.modes["retrocape"][1] ?? modes["retrocape"][1];
    }

    this.modes = {
      ...modes,
      ...this.modes, // if conflict, default to the preexisting modes
    };
    return compatible;
  }

  /**
   * Check if it is possible to equip a thing to this outfit using .equip().
   *
   * This does not change the current outfit.
   *
   * @param thing The thing to equip.
   * @param slot The slot to equip them.
   * @returns True if this thing can be equipped.
   */
  canEquip(thing: Equippable, slot?: Slot): boolean {
    const outfit = this.clone();
    return outfit.equip(thing, slot);
  }

  /**
   * Check if it is possible to equip a thing to this outfit using .equip(); if it is, do so.
   *
   * This does change the current outfit.
   * @param thing The thing to equip.
   * @param slot The slot to equip them.
   * @returns True if this thing was successfully equipped.
   */
  tryEquip(thing: Equippable, slot?: Slot): boolean {
    return this.canEquip(thing, slot) && this.equip(thing, slot);
  }

  /**
   * Equip this outfit.
   */
  private _dress(refreshed: boolean): void {
    if (this.familiar) useFamiliar(this.familiar);
    const targetEquipment = Array.from(this.equips.values());
    const usedSlots = new Set<Slot>();

    // First, we equip non-accessory equipment.
    const nonaccessorySlots = $slots`weapon, off-hand, hat, back, shirt, pants, familiar`;

    const bjorn = this.riders.get($slot`buddy-bjorn`);
    if (
      bjorn &&
      (this.equips.get($slot`back`) === $item`Buddy Bjorn` || this.getBonus($item`Buddy Bjorn`))
    ) {
      usedSlots.add($slot`buddy-bjorn`);
      usedSlots.add($slot`crown-of-thrones`);
    }

    const crown = this.riders.get($slot`crown-of-thrones`);
    if (
      crown &&
      (this.equips.get($slot`hat`) === $item`Crown of Thrones` ||
        this.getBonus($item`Crown of Thrones`))
    ) {
      usedSlots.add($slot`buddy-bjorn`);
      usedSlots.add($slot`crown-of-thrones`);
    }

    // We must manually remove equipment that we want to use in a different
    // slot than where it is currently equipped, to avoid a mafia issue.
    // Order is anchored here to prevent DFSS shenanigans
    for (const slot of nonaccessorySlots) {
      if (
        (targetEquipment.includes(equippedItem(slot)) &&
          this.equips.get(slot) !== equippedItem(slot)) ||
        this.avoid.includes(equippedItem(slot))
      )
        equip(slot, $item.none);
    }

    // Then we equip all the non-accessory equipment.
    for (const slot of nonaccessorySlots) {
      const equipment = this.equips.get(slot);
      if (equipment) {
        equip(slot, equipment);
        usedSlots.add(slot);
      }
    }

    // Next, we equip accessories
    const accessorySlots = $slots`acc1, acc2, acc3`;
    const accessoryEquips = accessorySlots
      .map((slot) => this.equips.get(slot))
      .filter((item) => item !== undefined) as Item[];

    // To plan how to equip accessories, first check which accessories are
    // already equipped in some accessory slot. There is no need to move them,
    // since KoL doesn't care what order accessories are equipped in.
    const missingAccessories = []; // accessories that are not already equipped
    for (const accessory of accessoryEquips) {
      const alreadyEquipped = accessorySlots.find(
        (slot) => !usedSlots.has(slot) && equippedItem(slot) === accessory
      );
      if (alreadyEquipped) {
        usedSlots.add(alreadyEquipped);
      } else {
        missingAccessories.push(accessory);
      }
    }

    // Then, for all accessories that are not currently equipped, use the first
    // open slot to place them.
    for (const accessory of missingAccessories) {
      const unusedSlot = accessorySlots.find((slot) => !usedSlots.has(slot));
      if (unusedSlot === undefined) {
        // This should only occur if there is a bug in .dress()
        throw `No accessory slots remaining`;
      }
      equip(unusedSlot, accessory);
      usedSlots.add(unusedSlot);
    }

    // Remaining slots are filled by the maximizer
    const modes = convertToLibramModes(this.modes);
    if (this.modifier.length > 0) {
      const allRequirements = [
        new Requirement(this.modifier, {
          preventSlot: [...usedSlots],
          preventEquip: this.avoid,
          modes: modes,
          bonusEquip: this.bonuses,
        }),
      ];

      if (refreshed) allRequirements.push(FORCE_REFRESH_REQUIREMENT);

      if (!Requirement.merge(allRequirements).maximize()) {
        if (!refreshed) {
          cliExecute("refresh inventory");
          this._dress(true);
          return;
        } else throw new Error("Failed to maximize properly!");
      }
      logprint(`Maximize: ${this.modifier}`);
    }

    // Set the modes of any equipped items.
    applyModes(modes);
    // Handle the rider slots next
    if (bjorn) {
      if (myEnthronedFamiliar() === bjorn) enthroneFamiliar($familiar.none);
      if (myBjornedFamiliar() !== bjorn) bjornifyFamiliar(bjorn);
    }
    if (crown) {
      if (myBjornedFamiliar() === crown) bjornifyFamiliar($familiar.none);
      if (myEnthronedFamiliar() !== crown) enthroneFamiliar(crown);
    }

    // Verify that all equipment was indeed equipped
    if (this.familiar !== undefined && myFamiliar() !== this.familiar)
      throw `Failed to fully dress (expected: familiar ${this.familiar})`;
    for (const slot of nonaccessorySlots) {
      if (this.equips.has(slot) && equippedItem(slot) !== this.equips.get(slot)) {
        throw `Failed to fully dress (expected: ${slot} ${this.equips.get(slot)})`;
      }
    }
    for (const accessory of accessoryEquips) {
      if (
        mafiaEquippedAmount(accessory) < accessoryEquips.filter((acc) => acc === accessory).length
      ) {
        throw `Failed to fully dress (expected: acc ${accessory})`;
      }
    }
    for (const [rider, checkingFunction] of [
      [$slot`buddy-bjorn`, myBjornedFamiliar],
      [$slot`crown-of-thrones`, myEnthronedFamiliar],
    ] as const) {
      const wanted = this.riders.get(rider);
      if (wanted && checkingFunction() !== wanted) {
        throw `Failed to fully dress: (expected ${rider} ${wanted})`;
      }
    }
  }

  public dress(): void {
    this._dress(false);
  }

  /**
   * Build an Outfit identical to this outfit.
   */
  clone(): Outfit {
    const result = new Outfit();
    result.equips = new Map(this.equips);
    result.skipDefaults = this.skipDefaults;
    result.familiar = this.familiar;
    result.modifier = [...this.modifier];
    result.avoid = [...this.avoid];
    result.modes = { ...this.modes };
    result.riders = new Map(this.riders);
    result.bonuses = new Map(this.bonuses);
    return result;
  }

  /**
   * Build an OutfitSpec identical to this outfit.
   */
  spec(): OutfitSpec {
    const result: OutfitSpec = {
      modifier: [...this.modifier],
      familiar: this.familiar,
      avoid: [...this.avoid],
      skipDefaults: this.skipDefaults,
      modes: { ...this.modes },
      bonuses: new Map(this.bonuses),
    };

    // Add all equipment forced in a particular slot
    for (const slotName of outfitSlots) {
      result[slotName] = this.equips.get(
        new Map([
          ["famequip", $slot`familiar`],
          ["offhand", $slot`off-hand`],
        ]).get(slotName) ?? toSlot(slotName)
      );
    }

    // Include the riders
    const riders: OutfitRiders = {};
    const buddyRider = this.riders.get($slot`buddy-bjorn`);
    if (buddyRider !== undefined) riders["buddy-bjorn"] = buddyRider;
    const throneRider = this.riders.get($slot`crown-of-thrones`);
    if (throneRider !== undefined) riders["crown-of-thrones"] = throneRider;
    if (buddyRider !== undefined || throneRider !== undefined) result.riders = riders;

    return result;
  }
}

/**
 * Get the modes of this outfit in a type compatible with Libram.
 *
 * This conversion is needed since we store the retrocape modes
 * internally as an array, but libram uses a string.
 *
 * @returns The modes equipped to this outfit.
 */
export function convertToLibramModes(modes: Modes): LibramModes {
  return {
    backupcamera: modes["backupcamera"],
    umbrella: modes["umbrella"],
    snowsuit: modes["snowsuit"],
    edpiece: modes["edpiece"],
    retrocape: modes["retrocape"]?.filter((s) => s !== undefined).join(" "),
    parka: modes["parka"],
  };
}

/**
 * Get the current modes of all items.
 *
 * @returns The current mode settings for all items, equipped or not.
 */
export function getCurrentModes(): Modes {
  return {
    backupcamera: getMode("backupCameraMode", ["ml", "meat", "init"]),
    umbrella: getMode("umbrellaState", [
      "broken",
      "forward-facing",
      "bucket style",
      "pitchfork style",
      "constantly twirling",
      "cocoon",
    ]),
    snowsuit: getMode("snowsuit", ["eyebrows", "smirk", "nose", "goatee", "hat"]),
    edpiece: getMode("edPiece", ["bear", "owl", "puma", "hyena", "mouse", "weasel", "fish"]),
    retrocape: [
      getMode("retroCapeSuperhero", ["vampire", "heck", "robot"]),
      getMode("retroCapeWashingInstructions", ["hold", "thrill", "kiss", "kill"]),
    ],
    parka: getMode("parkaMode", [
      "kachungasaur",
      "dilophosaur",
      "ghostasaurus",
      "spikolodon",
      "pterodactyl",
    ]),
  };
}

/**
 * Get the current value for a mode in a type-safe way.
 *
 * @param property The mafia property for the mode.
 * @param options A typed list of options for the mode.
 * @returns The mode if the property value matched a valid option, or undefined.
 */
function getMode<T extends string>(property: string, options: readonly T[]): T | undefined {
  const val = get(property, "");
  return options.find((s) => s === val); // .includes has type issues
}
