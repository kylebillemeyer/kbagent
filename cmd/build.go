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
	Use:          "build",
	Short:        "Build the Docker agent image for a project",
	SilenceUsage: true,
	Example: `  kbagent build                        # walks up from cwd to find kbagent.toml
  kbagent build -f /path/to/kbagent.toml`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load(cfgFile)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}

		if cfg.Daemon.Dockerfile == "" {
			return fmt.Errorf("daemon.dockerfile is not set in config — add the path to your Dockerfile (relative to repo_path or absolute)")
		}

		dockerfile := cfg.Daemon.Dockerfile
		if !filepath.IsAbs(dockerfile) {
			dockerfile = filepath.Join(cfg.Daemon.RepoPath, dockerfile)
		}

		if _, err := os.Stat(dockerfile); err != nil {
			return fmt.Errorf("dockerfile not found at %s", dockerfile)
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
