class DicerollCli < Formula
  desc "Cozy dice-rolling roguelite"
  homepage "https://diceroll.example.test"
  version "1.2.0"

  livecheck do
    url "https://key.example.test/diceroll/distribution/download.json"
    strategy :json do |json|
      json.dig("release", "version")
    end
  end

  on_macos do
    on_arm do
      url "https://key.example.test/diceroll/distribution/blobs/sha256/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    end
    on_intel do
      url "https://key.example.test/diceroll/distribution/blobs/sha256/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      sha256 "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    end
  end

  on_linux do
    on_arm do
      url "https://key.example.test/diceroll/distribution/blobs/sha256/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      sha256 "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    end
    on_intel do
      url "https://key.example.test/diceroll/distribution/blobs/sha256/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      sha256 "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    end
  end

  def install
    bin.install "diceroll-cli"
  end

  test do
    assert_path_exists bin/"diceroll-cli"
  end
end
