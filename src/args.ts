/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Class,
  ClassType,
  Effect,
  Familiar,
  Item,
  Location,
  Monster,
  Path,
  printHtml,
  Skill,
} from "kolmafia";
import { get } from "libram";

/**
 * Specification for an argument that takes values in T.
 * @member key The key to use when parsing this argument.
 * @member help Description for the help text.
 * @member options An array of allowable values for this argument.
 *    Each entry has an optional description for the help text as well.
 * @member setting A setting to use for this argument. If not given,
 *    ${script name}_${argument name} is used; set to "" for no setting.
 *    A value in this setting is used as the new default for this argument,
 *    and can be overridden by a command line argument.
 * @member hidden If true, do not display this option in the help text.
 * @member default A default value to use if no value is provided.
 *    Note that 'default' is effectively optional, as all methods that take
 *    an ArgSpec allow for 'default' to be omitted. But it is typed as
 *    non-optional here to enable cool type inference voodoo.
 */
interface ArgSpec<T> {
  key?: Exclude<string, "help">;
  help?: string;
  options?: [T, string?][];
  setting?: string;
  hidden?: boolean;
  default: T;
}
/**
 * Allow the default argument to be optional, in a way that allows for cool type inference.
 */
type ArgSpecNoDefault<T> = Omit<ArgSpec<T>, "default">;

/**
 * Specification for an argument that takes values in T[].
 *
 * Entries are parsed by splitting on the separator and trimming.
 *
 * @member separator String to use as the separator between entries. If not
 *    given, defaults to ",".
 * @member noTrim If true, do not perform trimming on each entry.
 * @member default A default value to use if no value is provided.
 *    Note that 'default' is effectively optional, as all methods that take
 *    an ArraySpec allow for 'default' to be omitted. But it is typed as
 *    non-optional here to enable cool type inference voodoo.
 */
interface ArraySpec<T> extends ArgSpecNoDefault<T> {
  separator?: string;
  noTrim?: boolean;
  default: T[];
}
type ArraySpecNoDefault<T> = Omit<ArraySpec<T>, "default">;

interface ArgOptions {
  defaultGroupName?: string; // Name to use in help text for the top-level group; defaults to "Options".
  positionalArgs?: string[]; // Key names of args that can be passed positionally, without the key being provided at runtime. (Not recommended, but provided for backwards compatability).
}

export class Args {
  /**
   * Create an argument for a custom type.
   * @param spec Specification for this argument.
   * @param parser A function to parse a string value into the proper type.
   * @param valueHelpName The name of this type, for the help text.
   * @returns An argument.
   */
  static custom<T>(spec: ArgSpec<T>, parser: Parser<T>, valueHelpName: string): Arg<T>;
  static custom<T>(
    spec: ArgSpecNoDefault<T>,
    parser: Parser<T>,
    valueHelpName: string
  ): ArgNoDefault<T>;
  static custom<T>(
    spec: ArgSpec<T> | ArgSpecNoDefault<T>,
    parser: Parser<T>,
    valueHelpName: string
  ): Arg<T> | ArgNoDefault<T> {
    const raw_options = spec.options?.map((option) => option[0]);

    // Check that the default value actually appears in the options.
    if ("default" in spec && raw_options) {
      if (!raw_options.includes(spec.default)) {
        throw `Invalid default value ${spec.default}`;
      }
    }

    return {
      ...spec,
      valueHelpName: valueHelpName,
      parser: (value: string): T | ParseError | undefined => {
        const parsed_value = parser(value);

        if (parsed_value === undefined || parsed_value instanceof ParseError) return parsed_value;
        if (raw_options) {
          if (!raw_options.includes(parsed_value)) {
            return new ParseError(`received ${value} which was not in the allowed options.`);
          }
        }
        return parsed_value;
      },
      options: spec.options?.map((a) => [`${a[0]}`, a[1]]),
    };
  }

  /**
   * Create an array argument for a given type.
   * @param spec Specification for this argument.
   * @param argFromSpec A function to create a non-array version of this arg.
   * @returns An argument.
   */
  private static arrayFromArg<T>(
    spec: ArraySpecNoDefault<T>,
    argFromSpec: (spec: ArgSpecNoDefault<T>) => ArgNoDefault<T>
  ): ArgNoDefault<T[]>;
  private static arrayFromArg<T>(
    spec: ArraySpec<T>,
    argFromSpec: (spec: ArgSpecNoDefault<T>) => ArgNoDefault<T>
  ): Arg<T[]>;
  private static arrayFromArg<T>(
    spec: ArraySpec<T> | ArraySpecNoDefault<T>,
    argFromSpec: (spec: ArgSpecNoDefault<T>) => ArgNoDefault<T>
  ): Arg<T[]> | ArgNoDefault<T[]> {
    // First, construct a non-array version of this argument.
    // We do this by calling argFromSpec in order to extract the parser and
    // valueHelpName (to make it easier to define the functions below).
    //
    // The default argument of an ArraySpec is of type T[], which causes
    // problems, so we must remove it.
    const spec_without_default = { ...spec } as any; // Avoid "the operand of a 'delete' operator must be optional"
    if ("default" in spec_without_default) delete spec_without_default["default"];
    const arg = argFromSpec(spec_without_default);

    // Next, check that all default values actually appear in the options.
    const raw_options = spec.options?.map((option) => option[0]);
    if ("default" in spec && raw_options) {
      for (const default_entry of spec.default) {
        if (!raw_options.includes(default_entry)) throw `Invalid default value ${spec.default}`;
      }
    }

    const arrayParser = (value: string): T[] | ParseError | undefined => {
      // Split the array
      let values = value.split(spec.separator ?? ",");
      if (!spec.noTrim) values = values.map((v) => v.trim());

      // Parse all values, return the first error found if any
      const result = values.map((v) => arg.parser(v));
      const error = result.find((v) => v instanceof ParseError);
      if (error) return error as ParseError;
      const failure_index = result.indexOf(undefined);
      if (failure_index !== -1)
        return new ParseError(
          `components expected ${arg.parser.name}$ but could not parse ${values[failure_index]}`
        );

      // Otherwise, all values are good
      return result as T[];
    };

    return {
      ...spec,
      valueHelpName: arg.valueHelpName,
      parser: arrayParser,
      options: spec.options?.map((a) => [`${a[0]}`, a[1]]),
    };
  }

  /**
   * Create a string argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static string(spec: ArgSpec<string>): Arg<string>;
  static string(spec: ArgSpecNoDefault<string>): ArgNoDefault<string>;
  static string(spec: ArgSpecNoDefault<string>): ArgNoDefault<string> {
    return this.custom<string>(spec, (value: string) => value, "TEXT");
  }

  /**
   * Create a string[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static strings(spec: ArraySpec<string>): Arg<string[]>;
  static strings(spec: ArraySpecNoDefault<string>): ArgNoDefault<string[]>;
  static strings(spec: ArraySpecNoDefault<string>): ArgNoDefault<string[]> {
    return this.arrayFromArg(spec, this.string);
  }

  /**
   * Create a number argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static number(spec: ArgSpec<number>): Arg<number>;
  static number(spec: ArgSpecNoDefault<number>): ArgNoDefault<number>;
  static number(spec: ArgSpecNoDefault<number>): ArgNoDefault<number> {
    return this.custom(
      spec,
      (value: string) => (isNaN(Number(value)) ? undefined : Number(value)),
      "NUMBER"
    );
  }

  /**
   * Create a number[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static numbers(spec: ArraySpec<number>): Arg<number[]>;
  static numbers(spec: ArraySpecNoDefault<number>): ArgNoDefault<number[]>;
  static numbers(spec: ArraySpecNoDefault<number>): ArgNoDefault<number[]> {
    return this.arrayFromArg(spec, this.number);
  }

  /**
   * Create a boolean argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static boolean(spec: ArgSpec<boolean>): Arg<boolean>;
  static boolean(spec: ArgSpecNoDefault<boolean>): ArgNoDefault<boolean>;
  static boolean(spec: ArgSpecNoDefault<boolean>): ArgNoDefault<boolean> {
    return this.custom(
      spec,
      (value: string) => {
        if (value.toLowerCase() === "true") return true;
        if (value.toLowerCase() === "false") return false;
        return undefined;
      },
      "BOOLEAN"
    );
  }

  /**
   * Create a boolean[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static booleans(spec: ArraySpec<boolean>): Arg<boolean[]>;
  static booleans(spec: ArraySpecNoDefault<boolean>): ArgNoDefault<boolean[]>;
  static booleans(spec: ArraySpecNoDefault<boolean>): ArgNoDefault<boolean[]> {
    return this.arrayFromArg(spec, this.boolean);
  }

  /**
   * Create a flag.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static flag(spec: ArgSpec<boolean>): Arg<boolean>;
  static flag(spec: ArgSpecNoDefault<boolean>): ArgNoDefault<boolean>;
  static flag(spec: ArgSpecNoDefault<boolean>): ArgNoDefault<boolean> {
    return this.custom(
      spec,
      (value: string) => {
        if (value.toLowerCase() === "true") return true;
        if (value.toLowerCase() === "false") return false;
        return undefined;
      },
      "FLAG"
    );
  }

  /**
   * Create a class argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static class(spec: ArgSpec<Class>): Arg<Class>;
  static class(spec: ArgSpecNoDefault<Class>): ArgNoDefault<Class>;
  static class(spec: ArgSpecNoDefault<Class>): ArgNoDefault<Class> {
    return this.custom(
      spec,
      (value: string) => {
        const match = Class.get(value as ClassType);
        // Class.get does fuzzy matching:
        //  e.g. Class.get("sc") returns disco bandit.
        // To avoid this foot-gun, only return exact matches or id lookups.
        if (match.toString().toUpperCase() === value.toString().toUpperCase()) return match;
        if (!isNaN(Number(value))) return match;
        return undefined;
      },
      "CLASS"
    );
  }

  /**
   * Create a Class[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static classes(spec: ArraySpec<Class>): Arg<Class[]>;
  static classes(spec: ArraySpecNoDefault<Class>): ArgNoDefault<Class[]>;
  static classes(spec: ArraySpecNoDefault<Class>): ArgNoDefault<Class[]> {
    return this.arrayFromArg(spec, this.class);
  }

  /**
   * Create an effect argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static effect(spec: ArgSpec<Effect>): Arg<Effect>;
  static effect(spec: ArgSpecNoDefault<Effect>): ArgNoDefault<Effect>;
  static effect(spec: ArgSpecNoDefault<Effect>): ArgNoDefault<Effect> {
    return this.custom(spec, Effect.get, "EFFECT");
  }

  /**
   * Create a Effect[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static effects(spec: ArraySpec<Effect>): Arg<Effect[]>;
  static effects(spec: ArraySpecNoDefault<Effect>): ArgNoDefault<Effect[]>;
  static effects(spec: ArraySpecNoDefault<Effect>): ArgNoDefault<Effect[]> {
    return this.arrayFromArg(spec, this.effect);
  }

  /**
   * Create a familiar argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static familiar(spec: ArgSpec<Familiar>): Arg<Familiar>;
  static familiar(spec: ArgSpecNoDefault<Familiar>): ArgNoDefault<Familiar>;
  static familiar(spec: ArgSpecNoDefault<Familiar>): ArgNoDefault<Familiar> {
    return this.custom(spec, Familiar.get, "FAMILIAR");
  }

  /**
   * Create a Familiar[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static familiars(spec: ArraySpec<Familiar>): Arg<Familiar[]>;
  static familiars(spec: ArraySpecNoDefault<Familiar>): ArgNoDefault<Familiar[]>;
  static familiars(spec: ArraySpecNoDefault<Familiar>): ArgNoDefault<Familiar[]> {
    return this.arrayFromArg(spec, this.familiar);
  }

  /**
   * Create an item argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static item(spec: ArgSpec<Item>): Arg<Item>;
  static item(spec: ArgSpecNoDefault<Item>): ArgNoDefault<Item>;
  static item(spec: ArgSpecNoDefault<Item>): ArgNoDefault<Item> {
    return this.custom(spec, Item.get, "ITEM");
  }

  /**
   * Create a Item[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static items(spec: ArraySpec<Item>): Arg<Item[]>;
  static items(spec: ArraySpecNoDefault<Item>): ArgNoDefault<Item[]>;
  static items(spec: ArraySpecNoDefault<Item>): ArgNoDefault<Item[]> {
    return this.arrayFromArg(spec, this.item);
  }

  /**
   * Create a location argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static location(spec: ArgSpec<Location>): Arg<Location>;
  static location(spec: ArgSpecNoDefault<Location>): ArgNoDefault<Location>;
  static location(spec: ArgSpecNoDefault<Location>): ArgNoDefault<Location> {
    return this.custom(spec, Location.get, "LOCATION");
  }

  /**
   * Create a Location[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static locations(spec: ArraySpec<Location>): Arg<Location[]>;
  static locations(spec: ArraySpecNoDefault<Location>): ArgNoDefault<Location[]>;
  static locations(spec: ArraySpecNoDefault<Location>): ArgNoDefault<Location[]> {
    return this.arrayFromArg(spec, this.location);
  }

  /**
   * Create a monster argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static monster(spec: ArgSpec<Monster>): Arg<Monster>;
  static monster(spec: ArgSpecNoDefault<Monster>): ArgNoDefault<Monster>;
  static monster(spec: ArgSpecNoDefault<Monster>): ArgNoDefault<Monster> {
    return this.custom(spec, Monster.get, "MONSTER");
  }

  /**
   * Create a Monster[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static monsters(spec: ArraySpec<Monster>): Arg<Monster[]>;
  static monsters(spec: ArraySpecNoDefault<Monster>): ArgNoDefault<Monster[]>;
  static monsters(spec: ArraySpecNoDefault<Monster>): ArgNoDefault<Monster[]> {
    return this.arrayFromArg(spec, this.monster);
  }

  /**
   * Create a path argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static path(spec: ArgSpec<Path>): Arg<Path>;
  static path(spec: ArgSpecNoDefault<Path>): ArgNoDefault<Path>;
  static path(spec: ArgSpecNoDefault<Path>): ArgNoDefault<Path> {
    return this.custom(spec, Path.get, "PATH");
  }

  /**
   * Create a Path[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static paths(spec: ArraySpec<Path>): Arg<Path[]>;
  static paths(spec: ArraySpecNoDefault<Path>): ArgNoDefault<Path[]>;
  static paths(spec: ArraySpecNoDefault<Path>): ArgNoDefault<Path[]> {
    return this.arrayFromArg(spec, this.path);
  }

  /**
   * Create a skill argument.
   * @param spec Specification for this argument. See {@link ArgSpec} for details.
   */
  static skill(spec: ArgSpec<Skill>): Arg<Skill>;
  static skill(spec: ArgSpecNoDefault<Skill>): ArgNoDefault<Skill>;
  static skill(spec: ArgSpecNoDefault<Skill>): ArgNoDefault<Skill> {
    return this.custom(spec, Skill.get, "SKILL");
  }

  /**
   * Create a Skill[] argument.
   * @param spec Specification for this argument. See {@link ArraySpec} for details.
   */
  static skills(spec: ArraySpec<Skill>): Arg<Skill[]>;
  static skills(spec: ArraySpecNoDefault<Skill>): ArgNoDefault<Skill[]>;
  static skills(spec: ArraySpecNoDefault<Skill>): ArgNoDefault<Skill[]> {
    return this.arrayFromArg(spec, this.skill);
  }

  /**
   * Create a group of arguments that will be printed separately in the help.
   *
   * Note that keys in the group must still be globally distinct.
   *
   * @param groupName The display name for the group in help.
   * @param args A JS object specifying the script arguments. Its values should
   *    be {@link Arg} objects (created by Args.string, Args.number, or others)
   *    or groups of arguments (created by Args.group).
   */
  static group<T extends ArgMap>(groupName: string, args: T): ArgGroup<T> {
    return {
      name: groupName,
      args: args,
    };
  }

  /**
   * Create a set of input arguments for a script.
   * @param scriptName Prefix for property names; often the name of the script.
   * @param scriptHelp Brief description of this script, for the help message.
   * @param args A JS object specifying the script arguments. Its values should
   *    be {@link Arg} objects (created by Args.string, Args.number, or others)
   *    or groups of arguments (created by Args.group).
   * @param options Config options for the args and arg parser.
   * @returns An object which can hold parsed argument values. The keys of this
   *    object are identical to the keys in 'args'.
   */
  static create<T extends ArgMap>(
    scriptName: string,
    scriptHelp: string,
    args: T,
    options?: ArgOptions
  ): ParsedArgs<T> & { help: boolean } {
    traverse(args, (keySpec, key) => {
      if (key === "help" || keySpec.key === "help") throw `help is a reserved argument name`;
    });

    const argsWithHelp = {
      ...args,
      help: this.flag({ help: "Show this message and exit.", setting: "" }),
    };

    // Create an object to hold argument results, with a default value for
    // each argument.
    const res: ParsedArgs<T> & { help: boolean } = {
      ...loadDefaultValues(argsWithHelp),
      [specSymbol]: argsWithHelp,
      [scriptSymbol]: scriptName,
      [scriptHelpSymbol]: scriptHelp,
      [optionsSymbol]: options ?? {},
    } as any;

    const metadata = Args.getMetadata(res);

    // Parse values from settings.
    metadata.traverseAndMaybeSet(res, (keySpec, key) => {
      const setting = keySpec.setting ?? `${scriptName}_${keySpec.key ?? key}`;
      if (setting === "") return undefined; // no setting
      const value_str = get(setting, "");
      if (value_str === "") return undefined; // no setting
      return parseAndValidate(keySpec, `Setting ${setting}`, value_str);
    });

    if (options?.positionalArgs) {
      const keys: string[] = [];
      metadata.traverse((keySpec, key) => {
        keys.push(keySpec.key ?? key);
      });
      for (const arg of options.positionalArgs) {
        if (!keys.includes(arg)) throw `Unknown key for positional arg: ${arg}`;
      }
    }
    return res;
  }

  /**
   * Parse the command line input into the provided script arguments.
   * @param args An object to hold the parsed argument values, from Args.create(*).
   * @param command The command line input.
   */
  static fill<T extends ArgMap>(args: ParsedArgs<T>, command: string | undefined): void {
    if (command === undefined || command === "") return;

    const metadata = Args.getMetadata(args);

    // Load the list of keys and flags from the arg spec
    const keys = new Set<string>();
    const flags = new Set<string>();
    metadata.traverse((keySpec, key) => {
      const name = keySpec.key ?? key;
      if (flags.has(name) || keys.has(name)) throw `Duplicate arg key ${name} is not allowed`;
      if (keySpec.valueHelpName === "FLAG") flags.add(name);
      else keys.add(name);
    });

    // Parse new argments from the command line
    const parsed = new CommandParser(
      command,
      keys,
      flags,
      metadata.options.positionalArgs ?? []
    ).parse();
    metadata.traverseAndMaybeSet(args, (keySpec, key) => {
      const argKey = keySpec.key ?? key;
      const value_str = parsed.get(argKey);
      if (value_str === undefined) return undefined; // no setting
      return parseAndValidate(keySpec, `Argument ${argKey}`, value_str);
    });
  }

  /**
   * Parse command line input into a new set of script arguments.
   * @param scriptName Prefix to use in property names; typically the name of the script.
   * @param scriptHelp Brief description of this script, for the help message.
   * @param spec An object specifying the script arguments.
   * @param command The command line input.
   * @param options Config options for the args and arg parser.
   */
  static parse<T extends ArgMap>(
    scriptName: string,
    scriptHelp: string,
    spec: T,
    command: string,
    options?: ArgOptions
  ): ParsedArgs<T> {
    const args = this.create(scriptName, scriptHelp, spec, options);
    this.fill(args, command);
    return args;
  }

  /**
   * Print a description of the script arguments to the CLI.
   *
   * First, all top-level argument descriptions are printed in the order they
   * were defined. Afterwards, descriptions for groups of arguments are printed
   * in the order they were defined.
   *
   * @param args An object of parsed arguments, from Args.create(*).
   * @param maxOptionsToDisplay If given, do not list more than this many options for each arg.
   */
  static showHelp<T extends ArgMap>(args: ParsedArgs<T>, maxOptionsToDisplay?: number): void {
    const metadata = Args.getMetadata(args);

    printHtml(`${metadata.scriptHelp}`);
    printHtml("");
    printHtml(`<b>${metadata.options.defaultGroupName ?? "Options"}:</b>`);
    metadata.traverse(
      (arg, key) => {
        if (arg.hidden) return;

        const nameText = `<font color='blue'>${arg.key ?? key}</font>`;
        const valueText =
          arg.valueHelpName === "FLAG" ? "" : `<font color='purple'>${arg.valueHelpName}</font>`;
        const helpText = arg.help ?? "";
        const defaultText =
          "default" in arg ? `<font color='#888888'>[default: ${arg.default}]</font>` : "";
        const settingText =
          arg.setting === ""
            ? ""
            : `<font color='#888888'>[setting: ${
                arg.setting ?? `${metadata.scriptName}_${arg.key ?? key}`
              }]</font>`;

        printHtml(
          `&nbsp;&nbsp;${[nameText, valueText, "-", helpText, defaultText, settingText].join(" ")}`
        );
        const valueOptions = arg.options ?? [];
        if (valueOptions.length < (maxOptionsToDisplay ?? Number.MAX_VALUE)) {
          for (const option of valueOptions) {
            if (option.length === 1) {
              printHtml(
                `&nbsp;&nbsp;&nbsp;&nbsp;<font color='blue'>${nameText}</font> ${option[0]}`
              );
            } else {
              printHtml(
                `&nbsp;&nbsp;&nbsp;&nbsp;<font color='blue'>${nameText}</font> ${option[0]} - ${option[1]}`
              );
            }
          }
        }
      },
      (group) => {
        printHtml("");
        printHtml(`<b>${group.name}:</b>`);
      }
    );
  }

  /**
   * Load the metadata information for a set of arguments. Only for advanced usage.
   *
   * @param args A JS object specifying the script arguments. Its values should
   *    be {@link Arg} objects (created by Args.string, Args.number, or others)
   *    or groups of arguments (created by Args.group).
   * @returns A class containing metadata information.
   */
  static getMetadata<T extends ArgMap>(args: ParsedArgs<T>): WrappedArgMetadata<T> {
    return new WrappedArgMetadata(args);
  }
}

/**
 * A group of arguments.
 */
type ArgGroup<T extends ArgMap> = {
  name: string;
  args: T;
};

export class ParseError {
  message: string;

  constructor(message: string) {
    this.message = message;
  }
}

/**
 * A parser that can transform a string value into the desired type.
 * It may return undefined if given an invalid value.
 */
type Parser<T> = (value: string) => T | ParseError | undefined;

/**
 * An argument that takes values in T.
 * @member parser The parser to use to built T values.
 * @member valueHelpName The string name of T, e.g. NUMBER.
 */
interface Arg<T> {
  // From ArgSpec
  key?: Exclude<string, "help">;
  help?: string;
  setting?: string;
  hidden?: boolean;
  default: T;

  parser: Parser<T>;
  valueHelpName: string;
  options?: [string, string?][];
}
/**
 * Allow the default argument to be optional, in a way that allows for cool type inference.
 */
type ArgNoDefault<T> = Omit<Arg<T>, "default">;

/**
 * Metadata for the parsed arguments.
 *
 * This information is hidden within the parsed argument object so that it
 * is invisible to the user but available to fill(*) and showHelp(*).
 */
const specSymbol: unique symbol = Symbol("spec");
const scriptSymbol: unique symbol = Symbol("script");
const scriptHelpSymbol: unique symbol = Symbol("scriptHelp");
const optionsSymbol: unique symbol = Symbol("options");
type ArgMetadata<T extends ArgMap> = {
  [specSymbol]: T;
  [scriptSymbol]: string;
  [scriptHelpSymbol]: string;
  [optionsSymbol]: ArgOptions;
};

/**
 * Construct the object type for the parsed arguments with typescript voodoo.
 *
 * The keys for the parsed argument object match the keys from the argument
 * specifications. That is, for each (key: spec) pair in the argument spec
 * object, there is a (key: value) in the parsed argument object.
 *
 * If spec has type Arg<T> (i.e., has a default), then value has type T.
 * If spec has type ArgNoDefault<T>, the value has type T | undefined.
 *
 * Finally, there are hidden keys in ArgMetadata for fill(*) and showHelp(*).
 */
type ArgMap = {
  [key: string]: Arg<unknown> | ArgNoDefault<unknown> | ArgGroup<ArgMap>;
};
type ParsedGroup<T extends ArgMap> = {
  [k in keyof T]: T[k] extends ArgGroup<any>
    ? ParsedGroup<T[k]["args"]>
    : T[k] extends Arg<unknown>
    ? Exclude<ReturnType<T[k]["parser"]>, undefined | ParseError>
    : T[k] extends ArgNoDefault<unknown>
    ? Exclude<ReturnType<T[k]["parser"]>, ParseError>
    : never;
};
type ParsedArgs<T extends ArgMap> = ParsedGroup<T> & ArgMetadata<T>;

/**
 * Parse a string into a value for a given argument, throwing if the parsing fails.
 * @param arg An argument that takes values in T.
 * @param source A description of where this value came from, for the error message.
 * @param value The value to parse.
 * @returns the parsed value.
 */
function parseAndValidate<T>(arg: Arg<T> | ArgNoDefault<T>, source: string, value: string): T {
  let parsed_value;
  try {
    parsed_value = arg.parser(value);
  } catch {
    parsed_value = undefined;
  }

  if (parsed_value === undefined)
    throw `${source} expected ${arg.parser.name}$ but could not parse ${value}`;
  if (parsed_value instanceof ParseError) throw `${source} ${parsed_value.message}`;
  return parsed_value;
}

/**
 * A class that reveals the hidden metadata and specs for arguments.
 *
 * Only for advanced usage.
 */
class WrappedArgMetadata<T extends ArgMap> {
  spec: T;
  scriptName: string;
  scriptHelp: string;
  options: ArgOptions;

  constructor(args: ParsedArgs<T>) {
    this.spec = args[specSymbol];
    this.scriptName = args[scriptSymbol];
    this.scriptHelp = args[scriptHelpSymbol];
    this.options = args[optionsSymbol];
  }

  /**
   * Create a parsed args object from this spec using all default values.
   */
  loadDefaultValues(): ParsedGroup<T> {
    return loadDefaultValues(this.spec);
  }

  /**
   * Traverse the spec and possibly generate a value for each argument.
   *
   * @param result The object to hold the resulting argument values, typically
   *    the result of loadDefaultValues().
   * @param setTo A function to generate an argument value from each arg spec.
   *    If this function returns undefined, then the argument value is unchanged.
   */
  traverseAndMaybeSet(
    result: ParsedArgs<T>,
    setTo: <S>(keySpec: Arg<S> | ArgNoDefault<S>, key: string) => S | undefined
  ) {
    return traverseAndMaybeSet(this.spec, result, setTo);
  }

  /**
   * Traverse the spec and call a method for each argument.
   *
   * @param process A function to call at each arg spec.
   */
  traverse(
    process: <S>(keySpec: Arg<S> | ArgNoDefault<S>, key: string) => void,
    onGroup?: <S extends ArgMap>(groupSpec: ArgGroup<S>, key: string) => void
  ) {
    return traverse(this.spec, process, onGroup);
  }
}

/**
 * Create a parsed args object from a spec using all default values.
 *
 * @param spec The spec for all arguments.
 */
function loadDefaultValues<T extends ArgMap>(spec: T): ParsedGroup<T> {
  const result: { [key: string]: any } = {};
  for (const k in spec) {
    const argSpec = spec[k];
    if ("args" in argSpec) {
      result[k] = loadDefaultValues(argSpec.args);
    } else {
      if ("default" in argSpec) result[k] = argSpec.default;
      else result[k] = undefined;
    }
  }
  return result as ParsedGroup<T>;
}

/**
 * Traverse the spec and possibly generate a value for each argument.
 *
 * @param spec The spec for all arguments.
 * @param result The object to hold the resulting argument values.
 * @param setTo A function to generate an argument value from each arg spec.
 *    If this function returns undefined, then the argument value is unchanged.
 */
function traverseAndMaybeSet<T extends ArgMap>(
  spec: T,
  result: ParsedArgs<T>,
  setTo: <S>(keySpec: Arg<S> | ArgNoDefault<S>, key: string) => S | undefined
) {
  const groups: [ArgGroup<ArgMap>, string][] = [];
  for (const k in spec) {
    const argSpec = spec[k];
    if ("args" in argSpec) {
      groups.push([argSpec, k]);
    } else {
      const value = setTo(argSpec, k);
      if (value === undefined) continue;
      result[k] = value as any;
    }
  }

  for (const group_and_key of groups) {
    traverseAndMaybeSet(group_and_key[0].args, result[group_and_key[1]] as any, setTo);
  }
}

/**
 * Traverse the spec and possibly generate a value for each argument.
 *
 * @param spec The spec for all arguments.
 * @param process A function to call at each arg spec.
 */
function traverse<T extends ArgMap>(
  spec: T,
  process: <S>(keySpec: Arg<S> | ArgNoDefault<S>, key: string) => void,
  onGroup?: <S extends ArgMap>(groupSpec: ArgGroup<S>, key: string) => void
) {
  const groups: [ArgGroup<ArgMap>, string][] = [];
  for (const k in spec) {
    const argSpec = spec[k];
    if ("args" in argSpec) {
      groups.push([argSpec, k]);
    } else {
      process(argSpec, k);
    }
  }

  for (const group_and_key of groups) {
    onGroup?.(group_and_key[0], group_and_key[1]);
    traverse(group_and_key[0].args, process, onGroup);
  }
}

/**
 * A parser to extract key/value pairs from a command line input.
 * @member command The command line input.
 * @member keys The set of valid keys that can appear.
 * @member flags The set of valid flags that can appear.
 * @member index An internal marker for the progress of the parser over the input.
 */
class CommandParser {
  private command: string;
  private keys: Set<string>;
  private flags: Set<string>;
  private positionalArgs: string[];

  private positionalArgsParsed: number;
  private index: number;

  private prevUnquotedKey: string | undefined;

  constructor(command: string, keys: Set<string>, flags: Set<string>, positionalArgs: string[]) {
    this.command = command;
    this.index = 0;
    this.keys = keys;
    this.flags = flags;
    this.positionalArgs = positionalArgs;
    this.positionalArgsParsed = 0;
  }

  /**
   * Perform the parsing of (key, value) pairs.
   * @returns The set of extracted (key, value) pairs.
   */
  parse(): Map<string, string> {
    this.index = 0; // reset the parser
    const result = new Map<string, string>();
    while (!this.finished()) {
      // A flag F may appear as !F to be parsed as false.
      let parsing_negative_flag = false;
      if (this.peek() === "!") {
        parsing_negative_flag = true;
        this.consume(["!"]);
      }

      const startIndex = this.index;
      const key = this.parseKey();
      if (result.has(key)) {
        throw `Duplicate key ${key} (first set to ${result.get(key) ?? ""})`;
      }
      if (this.flags.has(key)) {
        // The key corresponds to a flag.
        // Parse [key] as true and ![key] as false.
        result.set(key, parsing_negative_flag ? "false" : "true");
        if (this.peek() === "=") throw `Flag ${key} cannot be assigned a value`;
        if (!this.finished()) this.consume([" "]);
        this.prevUnquotedKey = undefined;
      } else if (this.keys.has(key)) {
        // Parse [key]=[value] or [key] [value]
        this.consume(["=", " "]);
        const value = this.parseValue();
        if (["'", '"'].includes(this.prev() ?? "")) this.prevUnquotedKey = undefined;
        else this.prevUnquotedKey = key;
        if (!this.finished()) this.consume([" "]);
        result.set(key, value);
      } else if (this.positionalArgsParsed < this.positionalArgs.length && this.peek() !== "=") {
        // Parse [value] as the next positional arg
        const positionalKey = this.positionalArgs[this.positionalArgsParsed];
        this.positionalArgsParsed++;

        this.index = startIndex; // back up to reparse the key as a value
        const value = this.parseValue();
        if (["'", '"'].includes(this.prev() ?? "")) this.prevUnquotedKey = undefined;
        else this.prevUnquotedKey = key;
        if (!this.finished()) this.consume([" "]);

        if (result.has(positionalKey))
          throw `Cannot assign ${value} to ${positionalKey} (positionally) since ${positionalKey} was already set to ${
            result.get(positionalKey) ?? ""
          }`;
        result.set(positionalKey, value);
      } else {
        // Key not found; include a better error message if it is possible for quotes to have been missed
        if (this.prevUnquotedKey && this.peek() !== "=")
          throw `Unknown argument: ${key} (if this should have been parsed as part of ${this.prevUnquotedKey}, you should surround the entire value in quotes)`;
        else throw `Unknown argument: ${key}`;
      }
    }
    return result;
  }

  /**
   * @returns True if the entire command has been parsed.
   */
  private finished(): boolean {
    return this.index >= this.command.length;
  }

  /**
   * @returns The next character to parse, if it exists.
   */
  private peek(): string | undefined {
    if (this.index >= this.command.length) return undefined;
    return this.command.charAt(this.index);
  }

  /**
   * @returns The character just parsed, if it exists.
   */
  private prev(): string | undefined {
    if (this.index <= 0) return undefined;
    if (this.index >= this.command.length + 1) return undefined;
    return this.command.charAt(this.index - 1);
  }

  /**
   * Advance the internal marker over the next expected character.
   * Throws an error on unexpected characters.
   *
   * @param allowed Characters that are expected.
   */
  private consume(allowed: string[]) {
    if (this.finished()) throw `Expected ${allowed}`;
    if (allowed.includes(this.peek() ?? "")) {
      this.index += 1;
    }
  }

  /**
   * Find the next occurance of one of the provided characters, or the end of
   * the string if the characters never appear again.
   *
   * @param searchValue The characters to locate.
   */
  private findNext(searchValue: string[]) {
    let result = this.command.length;
    for (const value of searchValue) {
      const index = this.command.indexOf(value, this.index);
      if (index !== -1 && index < result) result = index;
    }
    return result;
  }

  /**
   * Starting from the internal marker, parse a single key.
   * This also advances the internal marker.
   *
   * @returns The next key.
   */
  private parseKey(): string {
    const keyEnd = this.findNext(["=", " "]);
    const key = this.command.substring(this.index, keyEnd);
    this.index = keyEnd;
    return key;
  }

  /**
   * Starting from the internal marker, parse a single value.
   * This also advances the internal marker.
   *
   * Values are a single word or enclosed in matching quotes, i.e. one of:
   *    "[^"]*"
   *    '[^']*"
   *    [^'"][^ ]*
   *
   * @returns The next value.
   */
  private parseValue(): string {
    let valueEnder = " ";
    const quotes = ["'", '"'];
    if (quotes.includes(this.peek() ?? "")) {
      valueEnder = this.peek() ?? ""; // The value is everything until the next quote
      this.consume([valueEnder]); // Consume opening quote
    }

    const valueEnd = this.findNext([valueEnder]);
    const value = this.command.substring(this.index, valueEnd);
    if (valueEnder !== " " && valueEnd === this.command.length) {
      throw `No closing ${valueEnder} found for ${valueEnder}${value}`;
    }

    // Consume the value (and closing quote)
    this.index = valueEnd;
    if (valueEnder !== " ") this.consume([valueEnder]);
    return value;
  }
}
