package org.polariskey.s05;

import androidx.annotation.NonNull;

import com.google.android.play.core.assetpacks.AssetPackLocation;
import com.google.android.play.core.assetpacks.AssetPackManager;
import com.google.android.play.core.assetpacks.AssetPackManagerFactory;
import com.google.android.play.core.assetpacks.AssetPackState;

import org.godotengine.godot.Godot;
import org.godotengine.godot.plugin.GodotPlugin;
import org.godotengine.godot.plugin.UsedByGodot;

import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * S-05 (b): the smallest Play Asset Delivery bridge a Godot game needs. GDScript calls fetch(name),
 * polls getStatus(name) (AssetPackStatus: 4 = COMPLETED, 5 = FAILED) and then mounts
 * getAssetsPath(name) + "/<file>.pck" with ProjectSettings.load_resource_pack.
 */
public class S05Pad extends GodotPlugin {
	private final Map<String, AssetPackState> states = new ConcurrentHashMap<>();
	private AssetPackManager apm;

	public S05Pad(Godot godot) {
		super(godot);
	}

	@NonNull
	@Override
	public String getPluginName() {
		return "S05Pad";
	}

	private AssetPackManager apm() {
		if (apm == null) {
			apm = AssetPackManagerFactory.getInstance(getActivity().getApplicationContext());
			apm.registerListener(state -> states.put(state.name(), state));
		}
		return apm;
	}

	@UsedByGodot
	public void fetch(String name) {
		apm().fetch(Collections.singletonList(name)).addOnCompleteListener(t -> {
			if (t.isSuccessful()) {
				states.putAll(t.getResult().packStates());
			}
		});
	}

	@UsedByGodot
	public int getStatus(String name) {
		AssetPackState s = states.get(name);
		return s == null ? -1 : s.status();
	}

	@UsedByGodot
	public int getErrorCode(String name) {
		AssetPackState s = states.get(name);
		return s == null ? 0 : s.errorCode();
	}

	@UsedByGodot
	public String getAssetsPath(String name) {
		AssetPackLocation loc = apm().getPackLocation(name);
		return loc == null || loc.assetsPath() == null ? "" : loc.assetsPath();
	}

	@UsedByGodot
	public int getStorageMethod(String name) {
		AssetPackLocation loc = apm().getPackLocation(name);
		return loc == null ? -1 : loc.packStorageMethod();
	}
}
