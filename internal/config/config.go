package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

type Config struct {
	Daemon   DaemonConfig   `mapstructure:"daemon"`
	Dev      DevConfig      `mapstructure:"dev"`
	Provider ProviderConfig `mapstructure:"provider"`
}

type DaemonConfig struct {
	RepoPath        string `mapstructure:"repo_path"`
	WorktreesDir    string `mapstructure:"worktrees_dir"`
	RepoSlug        string `mapstructure:"repo_slug"`
	LogFile         string `mapstructure:"log_file"`
	TicketProvider  string `mapstructure:"ticket_provider"`
	MaxTurns        int    `mapstructure:"max_turns"`
	SleepNoWork     int    `mapstructure:"sleep_no_work"`
	SleepError      int    `mapstructure:"sleep_error"`
	KeychainService string `mapstructure:"keychain_service"`
	ValidateCmd     string `mapstructure:"validate_cmd"`
}

// DevConfig controls the kbagent dev SSH-tunnel feature.
type DevConfig struct {
	AppPort      int `mapstructure:"app_port"`
	PortRangeMin int `mapstructure:"port_range_min"`
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
	StateSpecApproved string `mapstructure:"state_spec_approved"`
	StateInProgress   string `mapstructure:"state_in_progress"`
	StateNeedsInput   string `mapstructure:"state_needs_input"`
	StateInReview     string `mapstructure:"state_in_review"`
}

// Load resolves config in this order:
//  1. cfgFile flag (-f/--file explicit path)
//  2. Walk up from cwd looking for kbagent.toml
func Load(cfgFile string) (*Config, error) {
	v := viper.New()

	if cfgFile != "" {
		v.SetConfigFile(cfgFile)
	} else {
		path, err := findConfigFile()
		if err != nil {
			return nil, err
		}
		v.SetConfigFile(path)
	}

	v.SetDefault("daemon.ticket_provider", "github")
	v.SetDefault("daemon.max_turns", 50)
	v.SetDefault("daemon.sleep_no_work", 15)
	v.SetDefault("daemon.sleep_error", 300)
	v.SetDefault("daemon.log_file", filepath.Join(os.Getenv("HOME"), "Library", "Logs", "kbagent.log"))
	v.SetDefault("daemon.keychain_service", "kbagent")
	v.SetDefault("dev.port_range_min", 3001)
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

// findConfigFile walks up from cwd until it finds a kbagent.toml.
func findConfigFile() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	start := dir
	for {
		path := filepath.Join(dir, "kbagent.toml")
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no kbagent.toml found in %s or any parent directory", start)
		}
		dir = parent
	}
}
