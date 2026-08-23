export const ROOT_HELP: string = `plugbot - build and run chat bots from plugins

Usage:
  plugbot <command> [options]

Commands:
  new      Create a plugin skeleton in a directory
  run      Run a bot from a configuration file
  dev      Run against the mock adapter with a REPL and hot reload
  doctor   Validate configuration and report what would load
  docs     Write a markdown reference for declared commands

Options:
  --config <path>   Configuration file (default: ./config.json, env PLUGBOT_CONFIG)
  --no-color        Disable coloured output
  --log-json        Emit logs as JSON lines
  --version         Print version
  -h, --help        Show help

Run "plugbot help <command>" for command details.
`;

export const ROOT_HINT: string = 'Run "plugbot help <command>" for command details.';

export const COMMAND_HELP: Record<"new" | "run" | "dev" | "doctor" | "docs", string> = {
  new: `Create a plugin skeleton file.

Usage:
  plugbot new <name> [--dir <directory>]

Arguments:
  <name>           Plugin name: lowercase letters, digits, hyphen; starts with a letter.
  --dir <dir>      Directory that receives the file (default: plugins).

Options:
  -h, --help       Show this help.

Examples:
  plugbot new ping
  plugbot new standup --dir plugins
`,
  run: `Run a bot from a configuration file.

Usage:
  plugbot run [--config <path>] [--adapter <type>] [--log-level <level>] [--no-color] [--log-json]

Arguments:
  None.

Options:
  --config <path>      Configuration file (default: ./config.json).
  --adapter <type>     Override adapter.type; one of mock, transcript, irc.
  --log-level <level>  Override logging.level; one of debug, info, warn, error.
  --no-color           Disable coloured output.
  --log-json           Emit logs as JSON lines.
  -h, --help           Show this help.

Examples:
  plugbot run
  plugbot run --config prod.json
  plugbot run --adapter mock --log-level debug
  plugbot run --log-json --no-color
`,
  dev: `Run against the mock adapter with a REPL and hot reload.

Usage:
  plugbot dev [--config <path>] [--dir <directory>]

Arguments:
  --config <path>    Configuration file (default: ./config.json).
  --dir <dir>        Plugin directory to watch and load (overrides plugins.dir).

Options:
  --no-color         Disable coloured output.
  --log-json         Emit logs as JSON lines.
  -h, --help         Show this help.

Examples:
  plugbot dev
  plugbot dev --config dev.json
  plugbot dev --dir plugins
`,
  doctor: `Validate configuration and report what would load.

Usage:
  plugbot doctor [--config <path>]

Arguments:
  --config <path>    Configuration file (default: ./config.json).

Options:
  -h, --help         Show this help.

Examples:
  plugbot doctor
  plugbot doctor --config config/prod.json
`,
  docs: `Write a markdown reference for declared commands.

Usage:
  plugbot docs [--out <file>] [--config <path>]

Arguments:
  --out <file>       File that receives the markdown (default: print to stdout).
  --config <path>    Configuration file (default: ./config.json).

Options:
  -h, --help         Show this help.

Examples:
  plugbot docs
  plugbot docs --out docs/commands.md
  plugbot docs --config config/prod.json --out commands.md
`,
};
