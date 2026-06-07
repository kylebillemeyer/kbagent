package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var installCompletionCmd = &cobra.Command{
	Use:   "install-completion",
	Short: "Install shell completion and print setup instructions",
	Long: `Writes a shell completion script and prints the lines to add to your shell rc file.

Supported shells: zsh, bash, fish.
Defaults to the current shell ($SHELL) if --shell is not specified.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		shell, _ := cmd.Flags().GetString("shell")
		if shell == "" {
			shell = filepath.Base(os.Getenv("SHELL"))
		}
		shell = strings.ToLower(shell)

		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}

		switch shell {
		case "zsh":
			dir := filepath.Join(home, ".zsh", "completions")
			file := filepath.Join(dir, "_kbagent")
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("create %s: %w", dir, err)
			}
			f, err := os.Create(file)
			if err != nil {
				return fmt.Errorf("write completion file: %w", err)
			}
			defer f.Close()
			if err := rootCmd.GenZshCompletion(f); err != nil {
				return err
			}
			fmt.Printf("✓ Written to %s\n\n", file)
			fmt.Println("Add these lines to ~/.zshrc if not already present:")
			fmt.Println()
			fmt.Printf("  fpath=(~/.zsh/completions $fpath)\n")
			fmt.Printf("  autoload -U compinit && compinit\n")
			fmt.Println()
			fmt.Println("Then reload: source ~/.zshrc")

		case "bash":
			dir := filepath.Join(home, ".bash_completions")
			file := filepath.Join(dir, "kbagent")
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("create %s: %w", dir, err)
			}
			f, err := os.Create(file)
			if err != nil {
				return fmt.Errorf("write completion file: %w", err)
			}
			defer f.Close()
			if err := rootCmd.GenBashCompletion(f); err != nil {
				return err
			}
			fmt.Printf("✓ Written to %s\n\n", file)
			fmt.Println("Add this line to ~/.bashrc if not already present:")
			fmt.Println()
			fmt.Printf("  source ~/.bash_completions/kbagent\n")
			fmt.Println()
			fmt.Println("Then reload: source ~/.bashrc")

		case "fish":
			dir := filepath.Join(home, ".config", "fish", "completions")
			file := filepath.Join(dir, "kbagent.fish")
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("create %s: %w", dir, err)
			}
			f, err := os.Create(file)
			if err != nil {
				return fmt.Errorf("write completion file: %w", err)
			}
			defer f.Close()
			if err := rootCmd.GenFishCompletion(f, true); err != nil {
				return err
			}
			fmt.Printf("✓ Written to %s\n\n", file)
			fmt.Println("Fish picks this up automatically — no rc changes needed.")
			fmt.Println("Reload: exec fish")

		default:
			return fmt.Errorf("unsupported shell %q — use --shell zsh|bash|fish", shell)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(installCompletionCmd)
	installCompletionCmd.Flags().String("shell", "", "shell type: zsh, bash, or fish (default: $SHELL)")
}
