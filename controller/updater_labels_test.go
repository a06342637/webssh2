package controller

import (
	"strconv"
	"strings"
	"testing"
)

// findFlagValue returns the value that follows the first occurrence of flag.
func findFlagValues(args []string, flag string) []string {
	var values []string
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag {
			values = append(values, args[i+1])
		}
	}
	return values
}

func TestUpdaterRunArgsLeavesComposeProject(t *testing.T) {
	// The updater image is built by compose, so it carries com.docker.compose.*
	// labels that docker run would otherwise inherit. Inheriting them makes the
	// updater look like a service instance of this project, and the compose up it
	// runs kills it mid-update, leaving the old container deleted and the new one
	// never started.
	args := updaterRunArgs("webssh-updater-1", "/root/webssh2", "/app/source", "webssh2-webssh", "echo hi")
	labels := findFlagValues(args, "--label")

	overrides := map[string]string{
		"com.docker.compose.project": updaterComposeProject,
		"com.docker.compose.service": "updater",
		"com.docker.compose.oneoff":  "True",
	}
	for key, want := range overrides {
		found := ""
		for _, label := range labels {
			if strings.HasPrefix(label, key+"=") {
				found = strings.TrimPrefix(label, key+"=")
			}
		}
		if found != want {
			t.Errorf("label %s = %q, want %q (inherited compose labels make the updater kill itself)", key, found, want)
		}
	}

	if updaterComposeProject == "webssh2" {
		t.Error("updater project name must differ from the deployment project name")
	}
}

func TestUpdaterRunArgsKeepsIdentifyingLabel(t *testing.T) {
	// Status polling and cleanup both find helpers through this label.
	args := updaterRunArgs("webssh-updater-1", "/root/webssh2", "/app/source", "webssh2-webssh", "echo hi")
	for _, label := range findFlagValues(args, "--label") {
		if label == "webssh.updater=true" {
			return
		}
	}
	t.Fatal("webssh.updater=true label is missing; status polling and cleanup would lose track of the helper")
}

func TestUpdaterRunArgsIncludesCreationTimestamp(t *testing.T) {
	args := updaterRunArgs("webssh-updater-1", "/root/webssh2", "/app/source", "webssh2-webssh", "echo hi")
	for _, label := range findFlagValues(args, "--label") {
		if strings.HasPrefix(label, "webssh.updater.created=") {
			if _, err := strconv.ParseInt(strings.TrimPrefix(label, "webssh.updater.created="), 10, 64); err != nil {
				t.Fatalf("invalid updater creation timestamp: %q", label)
			}
			return
		}
	}
	t.Fatal("webssh.updater.created label is missing")
}

func TestUpdaterRunArgsOrderAndPayload(t *testing.T) {
	script := "log 'update'"
	args := updaterRunArgs("webssh-updater-42", "/srv/app", "/app/source", "some-image", script)

	if len(args) < 2 || args[0] != "run" || args[1] != "-d" {
		t.Fatalf("args must start with `run -d`, got %v", args[:min(2, len(args))])
	}
	if got := findFlagValues(args, "--name"); len(got) != 1 || got[0] != "webssh-updater-42" {
		t.Errorf("--name = %v, want [webssh-updater-42]", got)
	}

	// Docker only treats flags before the image as its own; anything after is the
	// container command. Labels landing after the image would be silently ignored.
	imageIdx := -1
	for i, a := range args {
		if a == "some-image" {
			imageIdx = i
			break
		}
	}
	if imageIdx < 0 {
		t.Fatal("image missing from args")
	}
	for i, a := range args {
		if a == "--label" && i > imageIdx {
			t.Errorf("--label at %d appears after the image at %d; docker would ignore it", i, imageIdx)
		}
	}
	if args[len(args)-1] != script || args[len(args)-2] != "-lc" {
		t.Errorf("script must be the final `-lc <script>` pair, got %v", args[len(args)-2:])
	}

	mounts := findFlagValues(args, "-v")
	wantMount := "/srv/app:/srv/app"
	if !containsString(mounts, wantMount) {
		t.Errorf("mounts %v missing %q", mounts, wantMount)
	}
	if !containsString(mounts, "/var/run/docker.sock:/var/run/docker.sock") {
		t.Errorf("mounts %v missing the docker socket", mounts)
	}
}

func TestUpdateHelperBootstrapUsesSharedCommandUpdater(t *testing.T) {
	script := updateHelperBootstrapScript("/root/webssh2", "main", false)
	for _, want := range []string{
		"git fetch --prune origin \"$BRANCH\"",
		"git show \"${REMOTE_REF}:update.sh\"",
		"sh \"$TMP_SCRIPT\" --project-dir '/root/webssh2' --branch 'main'",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("bootstrap script missing %q:\n%s", want, script)
		}
	}
	if strings.Contains(script, "docker compose up") {
		t.Error("bootstrap must delegate build/activation to update.sh instead of keeping a second update implementation")
	}
}

func TestUpdateHelperBootstrapForwardsForce(t *testing.T) {
	script := updateHelperBootstrapScript("/srv/webssh", "stable", true)
	if !strings.Contains(script, "--project-dir '/srv/webssh' --branch 'stable' --force") {
		t.Fatalf("force option was not forwarded to update.sh:\n%s", script)
	}
}

func TestVersionHasUpdateDetectsRebuiltSourceWaitingForBinary(t *testing.T) {
	if !versionHasUpdate("0.5.63", "0.5.64", "same-commit", "same-commit") {
		t.Fatal("a source/binary version mismatch must remain updateable after an automatic image rollback")
	}
	if versionHasUpdate("0.5.64", "0.5.64", "same-commit", "same-commit") {
		t.Fatal("matching source, binary and remote versions must not report an update")
	}
	if !versionHasUpdate("0.5.64", "0.5.64", "old-commit", "new-commit") {
		t.Fatal("a different remote commit must report an update even when VERSION did not change")
	}
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
