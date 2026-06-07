package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var buildCmd = &cobra.Command{
	Use:   "build",
	Short: "Deprecated: agent images are no longer built by kbagent",
	Long: `The build command has been superseded by DevPod workspaces.

Each repo now provides its own .devcontainer/devcontainer.json which DevPod
uses to provision the agent environment. No Docker image build step is needed.

Prerequisites:
  brew install devpod
  Docker must be running locally
  Each repo must have .devcontainer/devcontainer.json`,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return fmt.Errorf("build is no longer supported — see 'kbagent build --help' for details")
	},
}

func init() {
	rootCmd.AddCommand(buildCmd)
}
