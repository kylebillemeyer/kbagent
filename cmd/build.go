package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/kylebillemeyer/kbagent/internal/config"
	"github.com/spf13/cobra"
)

var buildCmd = &cobra.Command{
	Use:          "build [project]",
	Short:        "Build the Docker agent image for a project",
	Args:         cobra.MaximumNArgs(1),
	SilenceUsage: true,
	Example: `  kbagent build                  # reads ./kbagent.toml
  kbagent build drum-trainer     # reads ~/.config/kbagent/drum-trainer.toml`,
	RunE: func(cmd *cobra.Command, args []string) error {
		project := ""
		if len(args) > 0 {
			project = args[0]
		}

		cfg, err := config.Load(cfgFile, project)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}

		dockerfile := cfg.Daemon.Dockerfile
		if !filepath.IsAbs(dockerfile) {
			dockerfile = filepath.Join(cfg.Daemon.RepoPath, dockerfile)
		}

		if _, err := os.Stat(dockerfile); err != nil {
			return fmt.Errorf("dockerfile not found at %s (set daemon.dockerfile in config)", dockerfile)
		}

		image := cfg.Daemon.DockerImage
		context := filepath.Dir(dockerfile)

		fmt.Printf("Building %s from %s\n", image, dockerfile)

		c := exec.Command("docker", "build", "-t", image, "-f", dockerfile, context)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		if err := c.Run(); err != nil {
			return fmt.Errorf("docker build failed: %w", err)
		}

		fmt.Printf("\n✓ Built %s\n", image)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(buildCmd)
}
