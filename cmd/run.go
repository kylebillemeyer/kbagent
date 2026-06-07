package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/kylebillemeyer/kbagent/internal/config"
	"github.com/kylebillemeyer/kbagent/internal/daemon"
	"github.com/kylebillemeyer/kbagent/internal/provider"
	"github.com/spf13/cobra"
)

var providerFlag string

var runCmd = &cobra.Command{
	Use:          "run [project]",
	Short:        "Start the agent daemon",
	Args:         cobra.MaximumNArgs(1),
	SilenceUsage: true,
	Example: `  kbagent run                   # reads ./kbagent.toml
  kbagent run drum-trainer      # reads ~/.config/kbagent/drum-trainer.toml
  kbagent run --config /path/to/kbagent.toml`,
	RunE: func(cmd *cobra.Command, args []string) error {
		project := ""
		if len(args) > 0 {
			project = args[0]
		}

		cfg, err := config.Load(cfgFile, project)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}

		if providerFlag != "" {
			cfg.Daemon.TicketProvider = providerFlag
		}

		p, err := provider.New(cfg)
		if err != nil {
			return fmt.Errorf("init provider: %w", err)
		}

		if err := p.CheckDeps(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

		return daemon.Run(context.Background(), cfg, p)
	},
}

func init() {
	rootCmd.AddCommand(runCmd)
	runCmd.Flags().StringVar(&providerFlag, "provider", "", "ticket provider: github or plane (overrides config)")
}
