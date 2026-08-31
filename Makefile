SHELL:=/bin/bash
MAPSHAPER := ./node_modules/.bin/mapshaper
SVGO := ./node_modules/.bin/svgo
SIMPLIFY_INTERVAL := 250m
# TODO: Do some dry runs without the dependencies to make it easy to get going from scratch (maybe look at nix flakes or something).
# TODO: motorways
# TODO: more BoWs

.PHONY: all screenshots
all: build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json

screenshots: build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json
	python utils/uk_geog/generate_screenshots.py \
		--dark \
		--only "City - Map,City - County,BoW - Map" \
		--sample "City - Map:City=Gloucester" \
		--sample "City - County:City=Gloucester" \
		--sample "BoW - Map:BoW=Bristol Channel" \
		--stitch build/screenshots/dark-mode-grid.png

# ==============================================================================
# 1. INGEST & NORMALIZE EARLY (All source files converted to EPSG:27700 TopoJSON)
# ==============================================================================

build/maps/base_27700/ons_itl1.topojson:
	mkdir -p build/maps/base_27700
	curl -sL 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/ITL1_JAN_2025_UK_BUC/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson' | \
	$(MAPSHAPER) -i - format=geojson -proj EPSG:27700 -clean -simplify interval=$(SIMPLIFY_INTERVAL) -rename-layers itl -o $@

build/maps/base_27700/natural_earth.topojson:
	mkdir -p build/maps/base_27700
	curl -sL 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson' | \
	$(MAPSHAPER) -i - format=geojson -filter 'ADM0_A3 == "FRA" || ADM0_A3 == "IRL" || ADM0_A3 == "IMN"' -proj EPSG:27700 -clean -simplify interval=$(SIMPLIFY_INTERVAL) -rename-layers natural_earth -o $@

build/maps/base_27700/scotland_council_areas.topojson:
	mkdir -p build/maps/base_27700
	curl -L "https://martinjc.github.io/UK-GeoJSON/json/sco/topo_lad.json" | \
	$(MAPSHAPER) -i - format=topojson -proj EPSG:27700 -clean -simplify interval=$(SIMPLIFY_INTERVAL) -o $@

build/maps/base_27700/gb_boundaries.topojson:
	mkdir -p build/maps/base_27700 build/maps/raw_gb
	curl -L 'https://api.os.uk/downloads/v1/products/BoundaryLine/downloads?area=GB&format=ESRI%C2%AE+Shapefile&redirect' | \
	bsdtar -xf - -C build/maps/raw_gb --include="Data/Supplementary_Ceremonial/*"
	$(MAPSHAPER) -i build/maps/raw_gb/Data/Supplementary_Ceremonial/*.shp -proj EPSG:27700 -clean -o $@ format=topojson
	rm -rf build/maps/raw_gb

build/maps/base_27700/n_ire_counties.topojson:
	mkdir -p build/maps/base_27700 build/maps/raw_ni
	curl -L -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
		'https://admin.opendatani.gov.uk/dataset/d0385f2d-6beb-4aff-87dc-f1bf357d792d/resource/636d6e61-593b-461c-ba5b-01214fecf6cb/download/osni_open_data_largescale_boundaries_county_boundaries.zip' | \
	bsdtar -xf - -C build/maps/raw_ni -s '|.*/||'
	$(MAPSHAPER) -i build/maps/raw_ni/*.shp -proj EPSG:27700 -clean -simplify interval=$(SIMPLIFY_INTERVAL) -o $@
	rm -rf build/maps/raw_ni

build/maps/base_27700/ni_cities.topojson:
	mkdir -p build/maps/base_27700
	curl -sL -A 'Mozilla/5.0' 'https://admin.opendatani.gov.uk/dataset/d27903f1-15e6-4c07-8564-ddc655e9c549/resource/cd65c0eb-0b85-448a-be85-1725dd2aeb48/download/osni_open_data_-_gazetteer_-_place_names.geojson' | \
	$(MAPSHAPER) \
		-i - format=geojson \
		-filter '["ARMAGH","BANGOR","BELFAST","LISBURN","LONDONDERRY","NEWRY"].indexOf(PLACENAME) > -1' \
		-each "name = (PLACENAME == 'LONDONDERRY') ? 'Derry' : (PLACENAME == 'BANGOR') ? 'Bangor (Northern Ireland)' : PLACENAME.charAt(0) + PLACENAME.slice(1).toLowerCase()" \
		-filter-fields name \
		-rename-layers ni_cities \
		-proj EPSG:27700 \
		-clean \
		-o format=topojson $@

build/maps/base_27700/gb_cities.topojson:
	mkdir -p build/maps/base_27700 build/maps/raw_gb_cities
	curl -L 'https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect=' | \
	bsdtar -xf - -C build/maps/raw_gb_cities
	cut -d ',' -f 3,4,5,6,8,9,10 build/maps/raw_gb_cities/Doc/OS_Open_Names_Header.csv > build/maps/gb_cities_temp.csv
	cut -d ',' -f 3,4,5,6,8,9,10 build/maps/raw_gb_cities/Data/* | grep ,City, >> build/maps/gb_cities_temp.csv
	$(MAPSHAPER) -i build/maps/gb_cities_temp.csv -points x=GEOMETRY_X y=GEOMETRY_Y -clean -o $@
	rm -rf build/maps/raw_gb_cities build/maps/gb_cities_temp.csv

build/maps/base_27700/seavox.topojson:
	mkdir -p build/maps/base_27700
	curl -L \
		-G 'https://geo.vliz.be/geoserver/MarineRegions/ows' \
		--data-urlencode 'service=WFS' \
		--data-urlencode 'version=1.0.0' \
		--data-urlencode 'request=GetFeature' \
		--data-urlencode 'typeName=MarineRegions:seavox_v19' \
		--data-urlencode 'outputFormat=application/json' \
		--data-urlencode 'CQL_FILTER=mrgid_l3 IN (23647,23649,23728,23729,23731) OR mrgid_sr IN (24188,24192,24193,24195,24210,24218) OR mrgid_l4 IN (23738,23739,23742,23735) OR mrgid_l2 = 23637' | \
		$(MAPSHAPER) -i - -proj EPSG:27700 -clean -simplify interval=$(SIMPLIFY_INTERVAL) -o $@

# ==============================================================================
# 2. DOWNSTREAM GEOPROCESSING
#    From here on we should be able to assume everything is EPSG:27700
#    Although we might need to remind $(MAPSHAPER) sometimes via -proj init
# ==============================================================================

build/maps/uk.topojson: build/maps/base_27700/ons_itl1.topojson
	$(MAPSHAPER) -i $< -dissolve -o $@

build/maps/canvas.topojson: build/maps/base_27700/natural_earth.topojson build/maps/uk.topojson
	$(MAPSHAPER) \
		-i name=roi build/maps/base_27700/natural_earth.topojson \
		-filter target=roi 'ADM0_A3 == "IRL"' \
		-i name=uk build/maps/uk.topojson \
		-merge-layers name=ukroi target=uk,roi force \
		-rectangle + name=canvas target=ukroi \
		-o $@ target=canvas

build/maps/extra_land.topojson: build/maps/base_27700/natural_earth.topojson build/maps/canvas.topojson
	$(MAPSHAPER) \
		-i name=ne build/maps/base_27700/natural_earth.topojson \
		-dissolve target=ne \
		-i name=canvas build/maps/canvas.topojson \
		-clip canvas target=ne \
		-o $@ target=ne

build/maps/regions.topojson build/regions.csv: build/maps/base_27700/ons_itl1.topojson
	$(MAPSHAPER) \
		-i name=itl build/maps/base_27700/ons_itl1.topojson \
		-filter-fields ITL125NM target=itl \
		-rename-fields name=ITL125NM target=itl \
		-each "name = name.replace(' (England)', '')" target=itl \
		-each "if (name == 'East') name = 'East of England'" target=itl \
		-each "if (name == 'Yorkshire and The Humber') name = 'Yorkshire and the Humber'" target=itl \
		-o build/maps/regions.topojson target=itl \
		-o build/regions.csv target=itl

build/maps/counties.topojson build/counties.csv: build/maps/base_27700/gb_boundaries.topojson build/maps/base_27700/n_ire_counties.topojson build/maps/base_27700/scotland_council_areas.topojson build/maps/regions.topojson
	mkdir -p build/maps
	$(MAPSHAPER) \
		-i name=n_ire build/maps/base_27700/n_ire_counties.topojson \
		-each 'name="County "+NAME.charAt(0) + NAME.slice(1).toLowerCase(), region_name="Northern Ireland"' target=n_ire \
		-i name=scotland build/maps/base_27700/scotland_council_areas.topojson \
		-each 'name=LAD13NM, joined=1, region_name="Scotland"' target=scotland \
		-i name=england_wales build/maps/base_27700/gb_boundaries.topojson \
		-join scotland target=england_wales fields=joined min-overlap-pct=0.05 \
		-filter 'joined !== 1' target=england_wales \
		-each 'name=NAME' target=england_wales \
		-i name=regions build/maps/regions.topojson \
		-rename-fields region_name=name target=regions\
		-join regions target=england_wales fields=region_name largest-overlap \
		-merge-layers name=counties target=england_wales,scotland,n_ire force \
		-filter-fields name,region_name target=counties \
		-each "if (name == 'West Midlands') name = 'West Midlands (county)'" target=counties \
		-each "if (name == 'Durham') name = 'County Durham'" target=counties \
		-each "if (name == 'City and County of the City of London') name = 'City of London'" target=counties \
		-each "if (name == 'Tyne & Wear') name = 'Tyne and Wear'" target=counties \
		-each "if (name == 'Aberdeen City') name = 'Aberdeen'" target=counties \
		-each "if (name == 'Dundee City') name = 'Dundee'" target=counties \
		-each "if (name == 'City of Edinburgh') name = 'Edinburgh'" target=counties \
		-each "if (name == 'Glasgow City') name = 'Glasgow'" target=counties \
		-each "if (name == 'Highland') name = 'Highland (council area)'" target=counties \
		-each "if (name == 'Stirling') name = 'Stirling (council area)'" target=counties \
		-each "if (name == 'Gwent') name = 'Gwent (county)'" target=counties \
		-each "if (name == 'Eilean Siar') name = 'Outer Hebrides'" target=counties \
		-clean \
		-clip regions target=counties \
		-proj init=EPSG:27700 target=counties \
		-simplify keep-shapes variable interval="name == 'City of London' ? 0 : '$(SIMPLIFY_INTERVAL)'" target=counties \
		-o build/maps/counties.topojson target=counties \
		-o build/counties.csv target=counties

build/maps/bodies_of_water.topojson build/bodies_of_water.csv: build/maps/base_27700/seavox.topojson build/maps/uk.topojson build/maps/extra_land.topojson build/maps/canvas.topojson src/data/mrgid_name_mapping.csv
	$(MAPSHAPER) \
		-i build/maps/base_27700/seavox.topojson name=seavox \
		-dissolve + name=l2 target=seavox mrgid_l2 \
		-dissolve + name=l3 target=seavox mrgid_l3 \
		-dissolve + name=l4 target=seavox mrgid_l4 \
		-filter target=l2 '"23637,".indexOf(mrgid_l2) > -1' \
		-filter target=l3 '"23647,23649,23728,23729,23731".indexOf(mrgid_l3) > -1' \
		-filter target=seavox '"24188,24192,24193,24195,24210,24218".indexOf(mrgid_sr) > -1' \
		-filter target=l4 '"23738,23739,23742,23735".indexOf(mrgid_l4) > -1' \
		-each 'mrgid=Number(mrgid_sr)' target=seavox \
		-each 'mrgid=Number(mrgid_l2)' target=l2 \
		-each 'mrgid=Number(mrgid_l3)' target=l3 \
		-each 'mrgid=Number(mrgid_l4)' target=l4 \
		-merge-layers force target=l2,l3,l4,seavox name=water \
		-filter-fields mrgid target=water\
		-join src/data/mrgid_name_mapping.csv keys=mrgid,mrgid target=water \
		-i build/maps/uk.topojson name=uk \
		-i build/maps/canvas.topojson name=canvas \
		-clip canvas target=water \
		-i build/maps/extra_land.topojson name=extra_land \
		-merge-layers force name=land target=extra_land,uk \
		-proj init=EPSG:27700 target="*" \
		-dissolve2 gap-fill-area=1km2 target=land \
		-erase source=land target=water \
		-each "if (name == 'St George\'s Channel') name = 'St Georges Channel'" target=water \
		-o build/maps/bodies_of_water.topojson target=water \
		-filter-fields name target=water\
		-o build/bodies_of_water.csv target=water

build/maps/cities.topojson build/cities.csv: build/maps/base_27700/ni_cities.topojson build/maps/base_27700/gb_cities.topojson build/maps/counties.topojson build/maps/canvas.topojson build/maps/extra_land.topojson
	$(MAPSHAPER) \
		-i name=ni_cities build/maps/base_27700/ni_cities.topojson \
		-i name=gb_cities build/maps/base_27700/gb_cities.topojson \
		-each "name = (NAME2_LANG == 'eng') ? NAME2 : NAME1" target=gb_cities \
		-each "name = (name == 'Bangor') ? 'Bangor (Wales)' : name " target=gb_cities \
		-filter "name != 'London'" target=gb_cities \
		-i build/maps/counties.topojson \
		-merge-layers name=cities target=ni_cities,gb_cities force \
		-filter-fields name target=cities \
		-i name=canvas build/maps/canvas.topojson \
		-i name=extra_land build/maps/extra_land.topojson \
		-proj init=EPSG:27700 target="*" \
		-o build/maps/cities.topojson target=cities,counties,canvas,extra_land \
		-o build/cities.csv target=cities


# ==============================================================================
# 3. RENDER ASSETS (SVG generation & Optimization)
# ==============================================================================

# Each layer is rendered as its own SVG with a shared viewBox (fit-extent=canvas),
# so _maps.js can compose the full maps from these building blocks at runtime.
MAP_LAYER_DIR := build/maps/layers

build/maps/layers/extra_land.svg: build/maps/extra_land.topojson build/maps/canvas.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		-o $@ target=extra_land format=svg id-field=name fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/counties.svg: build/maps/counties.topojson build/maps/extra_land.topojson build/maps/canvas.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-i build/maps/counties.topojson name=counties \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		-style target=counties fill="#ffe" stroke="#000" class="land" \
		-o $@ target=counties format=svg id-field=name fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/regions.svg: build/maps/regions.topojson build/maps/extra_land.topojson build/maps/canvas.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-i build/maps/regions.topojson name=regions \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		-style target=regions fill="#ffe" stroke="#000" class="land" \
		-o $@ target=regions format=svg id-field=name fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/cities.svg: build/maps/cities.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/cities.topojson \
		-style target=cities fill="#000" r=7 \
		-o $@ target=cities format=svg id-field=name fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/water.svg: build/maps/bodies_of_water.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i $< name=water \
		-style fill="#adf" stroke="#07b" \
		-sort expression=this.area descending \
		-o $@ format=svg id-field=name
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/extra_land.min.svg: build/maps/layers/extra_land.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/counties.min.svg: build/maps/layers/counties.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/regions.min.svg: build/maps/layers/regions.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/cities.min.svg: build/maps/layers/cities.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/water.min.svg: build/maps/layers/water.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

# _maps.js stores each SVG layer once as media (see utils/uk_geog/build_maps_js.py);
# templates inject composed maps into the DOM at render time instead of inlining them.
build/media/_maps.js: build/maps/layers/extra_land.min.svg build/maps/layers/counties.min.svg build/maps/layers/cities.min.svg build/maps/layers/regions.min.svg build/maps/layers/water.min.svg utils/uk_geog/build_maps_js.py
	python utils/uk_geog/build_maps_js.py

build/media/_zoombox.js: utils/uk_geog/media/_zoombox.js
	mkdir -p build/media
	cp "$<" "$@"

build/media/_move_to_front.js: utils/uk_geog/media/_move_to_front.js
	mkdir -p build/media
	cp "$<" "$@"


# ==============================================================================
# 4. NOTE TEMPLATE COMPILATION & BRAINBREW DECK GENERATION
# ==============================================================================

define COMPILE_TEMPLATE
	mkdir -p build/resolved_templates
	cat "utils/uk_geog/templates/$(1).front.html" > "build/resolved_templates/$(1).template.html"
	echo "" >> "build/resolved_templates/$(1).template.html"
	echo "--" >> "build/resolved_templates/$(1).template.html"
	echo "" >> "build/resolved_templates/$(1).template.html"
	cat "utils/uk_geog/templates/$(1).back.html" >> "build/resolved_templates/$(1).template.html"
	mv "build/resolved_templates/$(1).template.html" "build/resolved_templates/$(1).html"
endef

build/resolved_templates/Region\ -\ Map.html: utils/uk_geog/templates/Region\ -\ Map.front.html utils/uk_geog/templates/Region\ -\ Map.back.html
	$(call COMPILE_TEMPLATE,Region - Map)

build/resolved_templates/Map\ -\ Region.html: utils/uk_geog/templates/Map\ -\ Region.front.html utils/uk_geog/templates/Map\ -\ Region.back.html
	$(call COMPILE_TEMPLATE,Map - Region)

build/resolved_templates/County\ -\ Map.html: utils/uk_geog/templates/County\ -\ Map.front.html utils/uk_geog/templates/County\ -\ Map.back.html
	$(call COMPILE_TEMPLATE,County - Map)

build/resolved_templates/Map\ -\ County.html: utils/uk_geog/templates/Map\ -\ County.front.html utils/uk_geog/templates/Map\ -\ County.back.html
	$(call COMPILE_TEMPLATE,Map - County)

build/resolved_templates/City\ -\ Map.html: utils/uk_geog/templates/City\ -\ Map.front.html utils/uk_geog/templates/City\ -\ Map.back.html
	$(call COMPILE_TEMPLATE,City - Map)

build/resolved_templates/Map\ -\ City.html: utils/uk_geog/templates/Map\ -\ City.front.html utils/uk_geog/templates/Map\ -\ City.back.html
	$(call COMPILE_TEMPLATE,Map - City)

build/resolved_templates/City\ -\ County.html: utils/uk_geog/templates/City\ -\ County.front.html utils/uk_geog/templates/City\ -\ County.back.html
	$(call COMPILE_TEMPLATE,City - County)

build/resolved_templates/County\ -\ Region.html: utils/uk_geog/templates/County\ -\ Region.front.html utils/uk_geog/templates/County\ -\ Region.back.html
	$(call COMPILE_TEMPLATE,County - Region)

build/resolved_templates/Bow\ -\ Map.html: utils/uk_geog/templates/Bow\ -\ Map.front.html utils/uk_geog/templates/Bow\ -\ Map.back.html
	$(call COMPILE_TEMPLATE,Bow - Map)

build/resolved_templates/Map\ -\ BoW.html: utils/uk_geog/templates/Map\ -\ BoW.front.html utils/uk_geog/templates/Map\ -\ BoW.back.html
	$(call COMPILE_TEMPLATE,Map - BoW)

build/uk_geog.csv: utils/uk_geog/aggregate_csvs.py build/regions.csv build/counties.csv build/cities.csv build/bodies_of_water.csv src/data/cities.csv src/data/uk_geog.csv
	python $< \
		build/regions.csv \
		build/counties.csv \
		build/cities.csv \
		build/bodies_of_water.csv \
		src/data/cities.csv \
		$@ \
		--guids=src/data/uk_geog.csv

build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json: \
	recipes/UK_Geog/source_to_crowdanki.yaml \
	build/uk_geog.csv \
	src/note_models/UK_Geog/note_models.yaml \
	src/headers/UK_Geog/default.yaml \
	src/headers/UK_Geog/desc.html \
	brain_brew_config.yaml \
	src/note_models/UK_Geog/style.css \
	src/headers/UK_Geog/* \
	build/resolved_templates/Region\ -\ Map.html \
	build/resolved_templates/County\ -\ Map.html \
	build/resolved_templates/City\ -\ Map.html \
	build/resolved_templates/Map\ -\ Region.html \
	build/resolved_templates/Map\ -\ County.html \
	build/resolved_templates/Map\ -\ City.html \
	build/resolved_templates/County\ -\ Region.html \
	build/resolved_templates/City\ -\ County.html \
	build/resolved_templates/Bow\ -\ Map.html \
	build/resolved_templates/Map\ -\ BoW.html \
	build/media/_maps.js \
	build/media/_zoombox.js \
	build/media/_move_to_front.js
	mkdir -p build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/media
	pipenv run brainbrew run recipes/UK_Geog/source_to_crowdanki.yaml

clean:
	find build -mindepth 1 -not -path "build/maps/base_27700*" -delete
