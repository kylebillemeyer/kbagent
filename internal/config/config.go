package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

type Config struct {
	Daemon   DaemonConfig   `mapstructure:"daemon"`
	Provider ProviderConfig `mapstructure:"provider"`
}

type DaemonConfig struct {
	RepoPath        string `mapstructure:"repo_path"`
	WorktreesDir    string `mapstructure:"worktrees_dir"`
	DockerImage     string `mapstructure:"docker_image"`
	Dockerfile      string `mapstructure:"dockerfile"`
	LogFile         string `mapstructure:"log_file"`
	TicketProvider  string `mapstructure:"ticket_provider"`
	MaxTurns        int    `mapstructure:"max_turns"`
	SleepNoWork     int    `mapstructure:"sleep_no_work"`
	SleepError      int    `mapstructure:"sleep_error"`
	KeychainService string `mapstructure:"keychain_service"`
	ValidateCmd     string `mapstructure:"validate_cmd"`
}

type ProviderConfig struct {
	GitHub GitHubConfig `mapstructure:"github"`
	Plane  PlaneConfig  `mapstructure:"plane"`
}

type GitHubConfig struct {
	Repo string `mapstructure:"repo"`
}

type PlaneConfig struct {
	BaseURL           string `mapstructure:"base_url"`
	WorkspaceSlug     string `mapstructure:"workspace_slug"`
	ProjectID         string `mapstructure:"project_id"`
	StateBacklog      string `mapstructure:"state_backlog"`
	StateInProgress   string `mapstructure:"state_in_progress"`
	StateInReview     string `mapstructure:"state_in_review"`
	LabelSpecApproved string `mapstructure:"label_spec_approved"`
	LabelNeedsInput   string `mapstructure:"label_needs_input"`
}

// Load resolves config in this order:
//  1. cfgFile flag (explicit path)
//  2. project name → ~/.config/kbagent/<project>.toml
//  3. ./kbagent.toml in the current directory
func Load(cfgFile, project string) (*Config, error) {
	v := viper.New()

	if cfgFile != "" {
		v.SetConfigFile(cfgFile)
	} else if project != "" {
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".config", "kbagent", project+".toml")
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return nil, fmt.Errorf("no config found for project %q (looked at %s)", project, path)
		}
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("kbagent")
		v.SetConfigType("toml")
		v.AddConfigPath(".")
	}

	v.SetDefault("daemon.ticket_provider", "github")
	v.SetDefault("daemon.max_turns", 50)
	v.SetDefault("daemon.sleep_no_work", 1800)
	v.SetDefault("daemon.sleep_error", 300)
	v.SetDefault("daemon.docker_image", "agent")
	v.SetDefault("daemon.dockerfile", "scripts/Dockerfile")
	v.SetDefault("daemon.log_file", filepath.Join(os.Getenv("HOME"), "Library", "Logs", "kbagent.log"))
	v.SetDefault("daemon.keychain_service", "kbagent")
	v.SetDefault("provider.plane.base_url", "https://api.plane.so")

	if err := v.ReadInConfig(); err != nil {
		return nil, err
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// ConfigDir returns the directory where named project configs are stored.
func ConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "kbagent")
}
